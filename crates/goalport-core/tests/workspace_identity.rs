use goalport_core::{
    Campaign, Project, Store, Task, WorkStatus,
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    store::CampaignAuthorization,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn request(id: &str, message_type: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": message_type,
        "payload": payload
    }))
    .unwrap()
}

fn call(server: &CoreServer, id: &str, message_type: &str, payload: Value) -> Value {
    server
        .handle_json(&request(id, message_type, payload))
        .expect("valid connected UI envelope")
}

fn operational_canonical(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap();
    let value = canonical.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        value.into_owned()
    }
}

fn bundle(name: &str, root: &str) -> (Project, Campaign, Task, String, String) {
    let project = Project {
        id: format!("project-{name}"),
        workspace_root: root.into(),
    };
    let campaign = Campaign {
        id: format!("campaign-{name}"),
        goal: format!("goal {name}"),
        root_task_id: format!("task-{name}"),
        state: WorkStatus::InProgress,
    };
    let task = Task {
        id: campaign.root_task_id.clone(),
        campaign_id: campaign.id.clone(),
        title: format!("task {name}"),
        acceptance: "workspace identity is explicit".into(),
        state: WorkStatus::InProgress,
    };
    (
        project,
        campaign,
        task,
        format!("policy-{name}"),
        json!({"case": name}).to_string(),
    )
}

fn create_bundle(
    store: &Store,
    name: &str,
    root: &str,
) -> Result<Project, goalport_core::store::StoreError> {
    let (project, campaign, task, policy_id, policy) = bundle(name, root);
    store.create_workspace_campaign(
        &project,
        &campaign,
        &task,
        &policy_id,
        &policy,
        &CampaignAuthorization::granted(),
    )
}

#[test]
fn existing_mixed_case_workspace_preserves_operational_path_and_reuses_actual_alias() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("GoalPortCaseProbe");
    std::fs::create_dir(&workspace).unwrap();
    let expected = operational_canonical(&workspace);
    assert!(
        expected.contains("GoalPortCaseProbe"),
        "the fixture must retain a mixed-case component: {expected}"
    );

    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    let first = call(
        &server,
        "workspace-case-first",
        "create_campaign",
        json!({
            "workspaceRoot": workspace.join("."),
            "goal": "first mixed-case campaign",
            "title": "first task",
            "acceptance": "operational path remains case-preserved"
        }),
    );
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(
        first["payload"]["snapshot"]["project"]["workspaceRoot"],
        expected
    );

    let second = call(
        &server,
        "workspace-case-second",
        "create_campaign",
        json!({
            "workspaceRoot": PathBuf::from(&workspace),
            "goal": "second mixed-case campaign",
            "title": "second task",
            "acceptance": "the actual alias reuses one project"
        }),
    );
    assert_eq!(second["ok"], true, "{second}");
    assert_eq!(
        second["payload"]["snapshot"]["project"]["workspaceRoot"],
        expected
    );
    let counts = store.counts().unwrap();
    assert_eq!((counts.projects, counts.campaigns, counts.tasks), (1, 2, 2));
}

#[test]
fn unverified_case_fold_collision_refuses_atomically_but_exact_replay_is_idempotent() {
    let store = Store::memory().unwrap();
    let upper = r"Z:\goalport-workspace-identity\Foo";
    let lower = r"Z:\goalport-workspace-identity\foo";

    let first = create_bundle(&store, "upper", upper).unwrap();
    assert_eq!(first.workspace_root, upper);
    let baseline = store.counts().unwrap();

    let replay = create_bundle(&store, "upper", upper).unwrap();
    assert_eq!(replay, first);
    assert_eq!(store.counts().unwrap(), baseline);

    let refused = create_bundle(&store, "lower", lower).unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("workspace identity is ambiguous"),
        "unexpected refusal: {refused}"
    );
    assert_eq!(store.counts().unwrap(), baseline);
    assert!(store.get_project("project-lower").is_err());
    assert!(store.get_campaign("campaign-lower").is_err());
    assert!(store.get_task("task-lower").is_err());
    assert_eq!(store.campaign_project("campaign-lower").unwrap(), None);
    assert!(
        store
            .policy_snapshots_for_campaign("campaign-lower")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.get_campaign_authorization("campaign-lower").unwrap(),
        CampaignAuthorization::denied()
    );
}
