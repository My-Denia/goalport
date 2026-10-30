"""One ephemeral payload buffer. Not a status, budget, authorization or Ready cache."""
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path

STALE = "Workspace or target changed. Preview again."


class CheckRefusal(ValueError):
    def __init__(self, message, preview_again=False):
        super().__init__(message)
        self.preview_again = preview_again


def checked_payload(payload, start=False):
    required = {"requestId", "campaignId", "attemptId", "turnRequestId"}
    allowed = required | {"piCapacity"} | ({"backgroundConsent"} if start else set())
    def valid_id(value):
        return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._-]{1,256}", value) is not None
    if not isinstance(payload, dict) or set(payload) - allowed or not required <= set(payload):
        raise ValueError("Malformed workspace check request.")
    if not all(valid_id(payload[k]) for k in required):
        raise ValueError("Invalid workspace check identity.")
    pair = payload.get("piCapacity")
    if pair is not None and (not isinstance(pair, dict) or set(pair) != {"provider", "model", "useExistingCapacity"}
                             or pair["useExistingCapacity"] is not True or not all(isinstance(pair[k], str) and pair[k] and len(pair[k].encode()) <= 256 for k in ("provider", "model"))):
        raise ValueError("The requested Pi capacity is malformed.")
    if start and (pair is None or payload.get("backgroundConsent") is not True):
        raise ValueError("Select Pi capacity and keep-working consent explicitly.")
    return payload


def valid_material(value):
    try:
        from datetime import datetime
        if not isinstance(value, dict) or set(value) != {'exactPrompt', 'deliveredEvidence', 'coverage', 'contentObservation', 'nativeReportedContext', 'capturedAt', 'disclosureVersion'} or value['disclosureVersion'] != 1:
            return False
        datetime.fromisoformat(value['capturedAt'].replace('Z', '+00:00'))
        if any(not isinstance(value[k], str) or not value[k] or len(value[k].encode('utf-8')) > cap for k, cap in [('exactPrompt', 32768), ('deliveredEvidence', 16384)]):
            return False
        observation = value['contentObservation']
        if not isinstance(observation, dict) or set(observation) != {'head', 'paths', 'selectedDiff', 'selectedStatus', 'nativeReportedContext'}:
            return False
        if not isinstance(observation['head'], str) or re.fullmatch(r'[a-f0-9]{40,64}', observation['head']) is None or not isinstance(observation['paths'], list) or len(observation['paths']) > 512:
            return False
        if any(not isinstance(observation[k], str) or len(observation[k].encode('utf-8')) > 65536 for k in ('selectedDiff', 'selectedStatus')):
            return False
        context = value['nativeReportedContext']
        if not isinstance(context, dict) or set(context) != {'reply', 'replyTruncated', 'commands', 'commandsOmitted', 'commandsTruncated', 'filesTruncated', 'comparisonUnavailable', 'olderTurnsOmitted'} or observation['nativeReportedContext'] != context:
            return False
        if not isinstance(context['reply'], str) or len(context['reply'].encode('utf-8')) > 4096 or not isinstance(context['commands'], list) or len(context['commands']) > 6:
            return False
        if not all(type(context[k]) is bool for k in ('replyTruncated', 'commandsTruncated', 'filesTruncated', 'comparisonUnavailable')) or not all(type(context[k]) is int and context[k] >= 0 for k in ('commandsOmitted', 'olderTurnsOmitted')):
            return False
        coverage = value['coverage']
        return (isinstance(coverage, dict) and set(coverage) == {'limited', 'excluded', 'omitted', 'selected', 'evidenceCropped', 'excludedCategories'}
                and type(coverage['limited']) is bool and type(coverage['evidenceCropped']) is bool
                and all(type(coverage[k]) is int and coverage[k] >= 0 for k in ('excluded', 'omitted', 'selected'))
                and len(json.dumps(value, ensure_ascii=False).encode('utf-8')) <= 256 * 1024)
    except (ValueError, TypeError, KeyError, AttributeError):
        return False


class PreviewBuffer:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.packet = None
        self.expires = 0
        self.lock = threading.Lock()

    def put(self, packet):
        data = json.dumps(packet, ensure_ascii=False).encode("utf-8")
        if len(data) > 256 * 1024:
            raise ValueError("Workspace check packet is too large.")
        self.packet = json.loads(data)
        self.expires = self.clock() + 300

    def matching(self, payload):
        p = self.packet
        if not p or self.clock() >= self.expires:
            self.packet = None
            return None
        target = {k: payload[k] for k in ("campaignId", "attemptId", "turnRequestId")}
        if p.get("requestId") != payload["requestId"] or p.get("nativeCheckTarget") != target or p.get("piCapacity") != payload.get("piCapacity"):
            return None
        return p


def run_check(prefix, payload, runner, buffer, data_dir, start=False):
    checked_payload(payload, start)
    args = [*prefix, "native-check-start" if start else "native-check-prepare"]
    for key, flag in (("requestId", "--request-id"), ("campaignId", "--campaign-id"), ("attemptId", "--attempt-id"), ("turnRequestId", "--turn-request-id")):
        args.extend([flag, payload[key]])
    if payload.get("piCapacity") is not None:
        args.extend(["--pi-capacity", json.dumps(payload["piCapacity"], separators=(",", ":"))])
    with buffer.lock:
        temp = None
        try:
            if start:
                args.append("--background")
                packet = buffer.matching(payload)
                if packet is not None:
                    # Server-generated path only. mkstemp creates 0600, no renderer bytes.
                    fd, temp = tempfile.mkstemp(prefix="native-check-", suffix=".json", dir=data_dir)
                    with os.fdopen(fd, "w", encoding="utf-8") as output:
                        json.dump(packet, output, ensure_ascii=False)
                    args.extend(["--material-file", temp])
                # Even a lost/expired buffer must resolve a prior unique job first.
            else:
                buffer.packet = None
            code, out, err = runner(args)
            if code != 0:
                try:
                    disposition = json.loads(out)
                except (ValueError, TypeError):
                    disposition = None
                preview_again = disposition == {'nativeCheckRefused': True, 'previewAgain': True}
                raise CheckRefusal(err.strip() or STALE, preview_again)
            result = json.loads(out)
            if not isinstance(result, dict) or result.get("ok") is not True:
                raise ValueError("Workspace check reply is unavailable.")
            if not start and "nativeCheckMaterial" in result:
                buffer.put(result)
            if start:
                buffer.packet = None
            return result
        finally:
            if temp is not None:
                Path(temp).unlink(missing_ok=True)
