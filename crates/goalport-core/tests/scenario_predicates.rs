use serde_json::Value;
use std::{collections::HashSet, path::PathBuf, process::Command};

fn manifest_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/scenarios/manifest.json")
}

#[test]
fn every_manifest_id_has_its_own_executed_predicate_set() {
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(manifest_path()).expect("scenario manifest should be readable"),
    )
    .expect("scenario manifest should be valid JSON");
    let ids = manifest["scenarios"]
        .as_array()
        .expect("manifest scenarios should be an array")
        .iter()
        .map(|scenario| {
            scenario["id"]
                .as_str()
                .expect("manifest scenario should have an id")
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 23);

    let binary = env!("CARGO_BIN_EXE_goalport-core");
    let mut predicate_sets = HashSet::new();
    for id in ids {
        let output = Command::new(binary)
            .args([
                "scenario",
                "--id",
                &id,
                "--manifest",
                manifest_path()
                    .to_str()
                    .expect("manifest path should be UTF-8"),
            ])
            .output()
            .expect("scenario binary should start");
        assert!(
            output.status.success(),
            "{id} failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).expect("report should be JSON");
        assert_eq!(report["predicateSet"], id);
        assert_eq!(report["scenarioId"], id);
        assert_eq!(report["status"], "PASS");
        assert_eq!(report["executed"], 1);
        assert_eq!(report["skipped"], 0);

        let predicates = report["predicates"]
            .as_array()
            .expect("report should contain predicate names");
        assert!(
            predicates.len() >= 2,
            "{id} must execute at least two predicates"
        );
        let names = predicates
            .iter()
            .map(|predicate| {
                predicate
                    .as_str()
                    .expect("predicate entries should be names")
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(names.len(), names.iter().collect::<HashSet<_>>().len());
        assert_eq!(report["assertions"], names.len());
        assert!(
            names.iter().all(|name| name.starts_with(&format!("{id}:"))),
            "predicate names must be bound to {id}: {names:?}"
        );
        assert!(predicate_sets.insert(names));
    }
}
