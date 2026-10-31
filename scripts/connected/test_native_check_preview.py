import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('native_preview_fixture', Path(__file__).with_name('native_check_preview.py'))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class NativePreviewTest(unittest.TestCase):
    def payload(self):
        return {'requestId': 'synthetic-check', 'campaignId': 'campaign', 'attemptId': 'attempt', 'turnRequestId': 'turn', 'piCapacity': {'provider': 'Fixture', 'model': 'alpha', 'useExistingCapacity': True}}

    def test_closed_renderer_request_never_accepts_material_paths_bytes_or_execution(self):
        for key in ('exactPrompt', 'materialFile', 'workspacePath', 'execute', 'continuation', 'followUpMode', 'executionFeedback'):
            with self.assertRaises(ValueError):
                preview.checked_payload({**self.payload(), key: 'forbidden'})
        with self.assertRaises(ValueError):
            preview.checked_payload({**self.payload(), 'backgroundConsent': False}, True)

    def test_full_server_packet_transport_0600_cleanup_and_duplicate_after_expiry(self):
        clock = [0]
        buffer = preview.PreviewBuffer(lambda: clock[0])
        payload = self.payload()
        packet = {'ok': True, 'requestId': payload['requestId'], 'nativeCheckTarget': {k: payload[k] for k in ('campaignId', 'attemptId', 'turnRequestId')}, 'piCapacity': payload['piCapacity'], 'nativeCheckMaterial': {'exactPrompt': 'all shared bytes\n😀 '}}
        paths = []
        calls = []
        with tempfile.TemporaryDirectory(prefix='native-preview-fixture-') as directory:
            def runner(args):
                calls.append(args)
                if 'native-check-prepare' in args:
                    return 0, json.dumps(packet), ''
                if '--material-file' in args:
                    filename = Path(args[args.index('--material-file') + 1])
                    paths.append(filename)
                    self.assertEqual(json.loads(filename.read_text(encoding='utf-8')), packet)
                    self.assertEqual(filename.stat().st_mode & 0o777, 0o600)
                    self.assertNotEqual(filename.parent.resolve(), Path(directory).resolve(), 'packet must not inherit a mounted profile filesystem')
                return 0, json.dumps({'ok': True, 'job': {'jobId': 'own-recorded-job'}}), ''
            preview.run_check(['node', 'fixture'], payload, runner, buffer, directory)
            self.assertEqual(buffer.packet, packet)
            final = {**payload, 'backgroundConsent': True}
            result = preview.run_check(['node', 'fixture'], final, runner, buffer, directory, True)
            self.assertEqual(result['job']['jobId'], 'own-recorded-job')
            self.assertFalse(paths[0].exists())
            buffer.put(packet)
            clock[0] = 301
            preview.run_check(['node', 'fixture'], final, runner, buffer, directory, True)
            self.assertNotIn('--material-file', calls[-1], 'expired buffer still allows Node exact-ID lookup, never new packet')
            preview.run_check(['node', 'fixture'], final, runner, preview.PreviewBuffer(), directory, True)
            self.assertNotIn('--material-file', calls[-1], 'restart never restores preview bytes')
            self.assertNotIn('all shared bytes', json.dumps(calls))

    def test_guarded_http_message_types_use_server_buffer_only(self):
        import http.client
        import threading
        from http.server import ThreadingHTTPServer
        workbench_spec = importlib.util.spec_from_file_location('native_workbench_fixture', Path(__file__).with_name('linux-workbench.py'))
        wb = importlib.util.module_from_spec(workbench_spec)
        workbench_spec.loader.exec_module(wb)
        payload = self.payload()
        calls = []
        packet = {'ok': True, 'requestId': payload['requestId'], 'nativeCheckTarget': {k: payload[k] for k in ('campaignId', 'attemptId', 'turnRequestId')}, 'piCapacity': payload['piCapacity'], 'nativeCheckMaterial': {'exactPrompt': 'synthetic server bytes'}}
        def runner(args):
            calls.append(args)
            if 'native-check-prepare' in args:
                return 0, json.dumps(packet), ''
            filename = Path(args[args.index('--material-file') + 1])
            self.assertEqual(json.loads(filename.read_text()), packet)
            return 0, json.dumps({'ok': True, 'job': {'jobId': 'own-job'}}), ''
        with tempfile.TemporaryDirectory(prefix='native-check-http-') as folder:
            root = Path(folder)
            handler = wb.make_handler('/synthetic.sock', root, type('FakeUnix', (), {'MAX_FRAME_BYTES': 1024 * 1024})(), 1, root, runner, '/synthetic-core', '/synthetic-db')
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            def post(kind, data, origin=None):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
                headers = {'Content-Type': 'application/json', 'Origin': origin or f'http://127.0.0.1:{server.server_port}'}
                connection.request('POST', '/goalport/ipc', json.dumps({'messageType': kind, 'payload': data}), headers)
                response = connection.getresponse()
                result = response.status, json.loads(response.read())
                connection.close()
                return result
            self.assertEqual(post('native_workspace_check_prepare', payload, 'http://foreign.invalid')[0], 403)
            self.assertEqual(calls, [])
            self.assertFalse(post('native_workspace_check_prepare', {**payload, 'exactPrompt': 'renderer injection'})[1]['ok'])
            self.assertEqual(calls, [])
            self.assertTrue(post('native_workspace_check_prepare', payload)[1]['ok'])
            self.assertTrue(post('native_workspace_check_start', {**payload, 'backgroundConsent': True})[1]['ok'])
            self.assertEqual(len(calls), 2)
            self.assertEqual(list(root.glob('native-check-*.json')), [])

    def test_native_record_is_not_a_coordinated_root_or_continuation_but_exact_detail_survives(self):
        spec = importlib.util.spec_from_file_location('native_record_fixture', Path(__file__).with_name('linux-workbench.py'))
        wb = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(wb)
        with tempfile.TemporaryDirectory(prefix='native-record-fixture-') as folder:
            root = Path(folder)
            context = {'reply': 'reported', 'replyTruncated': False, 'commands': [], 'commandsOmitted': 0, 'commandsTruncated': False, 'filesTruncated': False, 'comparisonUnavailable': False, 'olderTurnsOmitted': 0}
            material = {'exactPrompt': 'exact bytes 😀 ', 'deliveredEvidence': 'diff', 'coverage': {'limited': False, 'excluded': 0, 'omitted': 0, 'selected': 1, 'evidenceCropped': False, 'excludedCategories': []}, 'contentObservation': {'head': 'a' * 40, 'paths': [], 'selectedDiff': 'diff', 'selectedStatus': '', 'nativeReportedContext': context}, 'nativeReportedContext': context, 'capturedAt': '2026-01-01T00:00:00Z', 'disclosureVersion': 1}
            self.assertTrue(preview.valid_material(material))
            self.assertTrue(preview.valid_material({**material, 'disclosureVersion': 2}))
            self.assertFalse(preview.valid_material({**material, 'disclosureVersion': 3}))
            self.assertFalse(preview.valid_material({**material, 'disclosureVersion': True}))
            target = {k: self.payload()[k] for k in ('campaignId', 'attemptId', 'turnRequestId')}
            ordinary = {'requestId': 'ordinary', 'goal': 'Ordinary goal', 'workspacePath': '/fixture', 'verdict': 'checked', 'stopReason': 'returned', 'savedAt': '2026-01-01T00:00:00Z'}
            check = {**ordinary, 'requestId': 'check', 'recordKind': 'native-workspace-check', 'nativeCheckTarget': target, 'nativeCheckMaterial': material, 'piCapacity': self.payload()['piCapacity'], 'auditText': 'Concrete independent critique', 'savedAt': '2026-01-02T00:00:00Z'}
            records = root / 'coordination-records.json'
            records.write_text(json.dumps([check, ordinary]), encoding='utf-8')
            detail = wb.latest_coordination_record(root, 'check')
            self.assertEqual(len(detail['roots']), 1)
            self.assertEqual(detail['record']['nativeCheckMaterial']['exactPrompt'], material['exactPrompt'])
            self.assertFalse(detail['record']['nativeAssociation'])
            self.assertIsNone(detail['record']['rootRequestId'])
            self.assertEqual(wb.latest_coordination_record(root)['record']['requestId'], 'ordinary')
            job = root / 'coordination-jobs' / 'jobs' / '00000000-0000-4000-8000-000000000001'
            job.mkdir(parents=True)
            admission = {'requestId': 'check', 'workspacePath': '/fixture', 'goal': 'Ordinary goal', 'allowedInstances': ['pi'], 'maxTurns': 2, 'writeAuthorization': None, 'backgroundConsent': True, 'priorPlan': None, 'priorReview': None, 'avoidInstances': [], 'piCapacity': check['piCapacity'], 'nativeCheckTarget': target, 'nativeCheckMaterial': material}
            (job / 'admission.json').write_text(json.dumps({'schema': 'goalport.coordination-job-admission.v1', 'jobId': job.name, 'createdAt': '2026-01-01T00:00:00Z', 'input': admission}), encoding='utf-8')
            self.assertTrue(wb.latest_coordination_record(root, 'check')['record']['nativeAssociation'])
            records.write_text(json.dumps([check, check, ordinary]), encoding='utf-8')
            self.assertFalse(wb.native_check_record(root, check)['nativeAssociation'])
            records.write_text(json.dumps([check, ordinary]), encoding='utf-8')
            admission['nativeCheckTarget'] = {**target, 'attemptId': 'other'}
            (job / 'admission.json').write_text(json.dumps({'schema': 'goalport.coordination-job-admission.v1', 'jobId': job.name, 'createdAt': '2026-01-01T00:00:00Z', 'input': admission}), encoding='utf-8')
            self.assertFalse(wb.latest_coordination_record(root, 'check')['record']['nativeAssociation'])
            child = {**ordinary, 'requestId': 'child', 'continuation': {'parentRequestId': 'check', 'rootRequestId': 'check', 'originalGoal': 'Ordinary goal', 'followUp': 'next'}}
            self.assertIsNone(wb.SavedTargets([check, child]).selected('child')['rootRequestId'])

    def test_pre_admission_refusal_is_typed_but_unknown_output_never_authorizes_refresh(self):
        with tempfile.TemporaryDirectory(prefix='native-refusal-fixture-') as directory:
            for output, expected in [(json.dumps({'nativeCheckRefused': True, 'previewAgain': True}), True), ('', False), ('unconfirmed provider text says Preview again', False)]:
                with self.assertRaises(preview.CheckRefusal) as failure:
                    preview.run_check(['node', 'fixture'], {**self.payload(), 'backgroundConsent': True}, lambda _args: (1, output, 'Synthetic refusal'), preview.PreviewBuffer(), directory, True)
                self.assertEqual(failure.exception.preview_again, expected)

    def test_buffer_caps_pair_target_and_explicit_refresh(self):
        b = preview.PreviewBuffer()
        with self.assertRaises(ValueError):
            b.put({'bytes': 'x' * (256 * 1024)})
        b.put({'requestId': 'other'})
        self.assertIsNone(b.matching(self.payload()))


if __name__ == '__main__':
    unittest.main()
