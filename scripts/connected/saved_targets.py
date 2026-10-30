"""Read-only saved-target relations, matching saved-targets.cjs. Never repairs disk."""
import ntpath
import posixpath
import re


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._-]{1,256}", value) is not None


def workspace_key(value):
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    return ntpath.normpath(value).lower() if re.match(r"^[A-Za-z]:[\\/]", value) else posixpath.normpath(value)


def js_length(value):
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def valid_descriptor(value):
    return (isinstance(value, dict) and set(value) == {"parentRequestId", "rootRequestId", "originalGoal", "followUp"}
            and all(isinstance(value[k], str) for k in value)
            and valid_id(value["parentRequestId"].strip()) and valid_id(value["rootRequestId"].strip())
            and bool(value["originalGoal"].strip())
            and js_length(value["originalGoal"].strip()) + js_length(value["followUp"].strip()) <= 100000)


class SavedTargets:
    def __init__(self, raw):
        self.records = [r for r in raw if isinstance(r, dict)] if isinstance(raw, list) else []
        self.index = {}
        for record in self.records:
            key = record.get("requestId")
            if isinstance(key, str):
                self.index.setdefault(key, []).append(record)
        self.entries = [{"record": r, **self.relation(r)} for r in self.records]

    def unique(self, key):
        items = self.index.get(key, []) if isinstance(key, str) else []
        return items[0] if valid_id(key) and len(items) == 1 else None

    def relation(self, record):
        def invalid(reason, status="invalid"):
            return {"relationStatus": status, "relationUnavailableReason": reason, "rootRequestId": None}
        key = record.get("requestId")
        if not valid_id(key):
            return invalid("The saved result has no usable identity.")
        if len(self.index[key]) != 1:
            return invalid("This saved result cannot be identified uniquely.", "ambiguous")
        if not isinstance(record.get("goal"), str) or not record["goal"].strip() or not workspace_key(record.get("workspacePath")):
            return invalid("The saved goal or folder is unavailable.")
        if record.get("recordKind") == "native-workspace-check":
            return invalid("Workspace checks belong to a native goal, not a coordinated root.")
        if "continuation" not in record:
            return {"relationStatus": "legacy-root", "rootRequestId": key, "relationUnavailableReason": None}
        descriptor = record["continuation"]
        if not valid_descriptor(descriptor):
            return invalid("The saved goal relationship is unavailable.")
        root = self.unique(descriptor["rootRequestId"])
        if root is None or root.get("recordKind") == "native-workspace-check" or "continuation" in root or not isinstance(root.get("goal"), str) or not root["goal"].strip() or not workspace_key(root.get("workspacePath")):
            return invalid("The original saved goal cannot be identified.")
        workspace = workspace_key(record.get("workspacePath"))
        if (descriptor["originalGoal"] != str(root.get("goal", "")).strip() or record["goal"].strip() != descriptor["originalGoal"]
                or workspace_key(root.get("workspacePath")) != workspace):
            return invalid("The original goal or folder does not match.")
        visited = set()
        cursor = record
        for _ in range(len(self.records) + 1):
            key = cursor.get("requestId")
            if key in visited:
                return invalid("The saved goal relationship contains a cycle.")
            visited.add(key)
            if cursor is root:
                return {"relationStatus": "valid", "rootRequestId": root["requestId"], "continuation": dict(descriptor), "relationUnavailableReason": None}
            d = cursor.get("continuation")
            if (cursor.get("recordKind") == "native-workspace-check" or not valid_descriptor(d) or d["rootRequestId"] != root["requestId"] or d["originalGoal"] != descriptor["originalGoal"]
                    or str(cursor.get("goal", "")).strip() != descriptor["originalGoal"] or workspace_key(cursor.get("workspacePath")) != workspace):
                return invalid("An earlier result belongs to a different goal or folder.")
            cursor = self.unique(d["parentRequestId"])
            if cursor is None:
                return invalid("An earlier saved result cannot be identified.")
        return invalid("The saved goal relationship could not be followed.")

    def selected(self, key):
        record = self.unique(key)
        return next((e for e in self.entries if e["record"] is record), None) if record is not None else None

    def head(self, root_id):
        members = [e["record"] for e in self.entries if e["rootRequestId"] == root_id]
        dated = [r for r in members if isinstance(r.get("savedAt"), str) and r["savedAt"]]
        if not dated:
            return members[0]["requestId"] if len(members) == 1 else None
        stamp = max(r["savedAt"] for r in dated)
        heads = [r for r in dated if r["savedAt"] == stamp]
        return heads[0]["requestId"] if len(heads) == 1 else None
