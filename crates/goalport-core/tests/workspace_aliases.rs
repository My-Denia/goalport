use goalport_core::{normalize_workspace_key, workspace_keys_overlap};
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;

#[cfg(windows)]
fn absent_probe_paths() -> (PathBuf, PathBuf) {
    let long_root = PathBuf::from(r"C:\Program Files");
    let short_root = PathBuf::from(r"C:\PROGRA~1");
    assert_eq!(
        std::fs::canonicalize(&long_root).unwrap(),
        std::fs::canonicalize(&short_root).unwrap(),
        "the Windows fixture needs the existing Program Files 8.3 alias"
    );

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let name = format!("goalport-workspace-alias-{}-{nonce}", std::process::id());
    let long = long_root.join(&name);
    let short = short_root.join(name);
    assert!(!long.exists(), "the probe descendant must start absent");
    assert!(
        !short.exists(),
        "the alias probe descendant must start absent"
    );
    (long, short)
}

#[cfg(windows)]
#[test]
fn missing_descendants_expand_an_existing_short_ancestor_without_writes() {
    let (long, short) = absent_probe_paths();

    assert_eq!(
        normalize_workspace_key(&long),
        normalize_workspace_key(&short),
        "an absent workspace must retain the filesystem identity of its existing ancestor"
    );
    assert!(workspace_keys_overlap(
        &normalize_workspace_key(&long),
        &normalize_workspace_key(&short.join("nested")),
    ));
    assert!(workspace_keys_overlap(
        &normalize_workspace_key(&long.join("nested")),
        &normalize_workspace_key(&short),
    ));
    assert!(!workspace_keys_overlap(
        &normalize_workspace_key(&long.join("left")),
        &normalize_workspace_key(&short.join("right")),
    ));

    assert!(
        !long.exists(),
        "normalization must not create the workspace"
    );
    assert!(
        !short.exists(),
        "normalization through an alias must remain read-only"
    );
}

#[test]
fn lexical_dot_unc_and_component_boundaries_remain_stable() {
    assert_eq!(
        normalize_workspace_key(Path::new(r"C:\work\.\child\..")),
        r"c:\work"
    );
    assert_eq!(
        normalize_workspace_key(Path::new(r"\\?\UNC\Server\Share\.\child\..")),
        r"\\server\share"
    );
    assert!(!workspace_keys_overlap(r"C:\work", r"C:\workshop"));
}

#[cfg(not(windows))]
#[test]
fn windows_looking_paths_on_unix_stay_lexical() {
    assert_eq!(
        normalize_workspace_key(Path::new(r"C:\PROGRA~1\missing\..\child")),
        r"c:\progra~1\child"
    );
}
