import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('tryon', Path(__file__).resolve().parents[1] / 'server/tryon.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TryonTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.jobs = module.Jobs(Path(self.directory.name) / 'jobs.sqlite3')
        self.inputs = {'id': 'test-123', 'model': 'https://example.com/model.png', 'garment': 'https://example.com/top.png'}
        self.handle = {'status_url': 'https://queue.fal.run/fal-ai/fashn/requests/123/status',
                       'response_url': 'https://queue.fal.run/fal-ai/fashn/requests/123'}
        self.env = patch.dict(os.environ, {'FAL_KEY': 'test-only'})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.directory.cleanup()

    def test_submit_is_durable_and_idempotent(self):
        with patch.object(module, 'provider', return_value=self.handle) as provider:
            self.jobs.submit(self.inputs)
            restarted = module.Jobs(self.jobs.database)
            restarted.submit(self.inputs)
            self.assertEqual(provider.call_count, 1)
            self.assertEqual(provider.call_args.args[2]['category'], 'auto')
        with patch.object(module, 'provider', side_effect=[{'status': 'COMPLETED'}, {'images': [{'url': 'https://example.com/result.png'}]}]):
            self.assertEqual(restarted.status('test-123')['state'], 'completed')
        with patch.object(module, 'provider') as provider:
            self.assertEqual(restarted.status('test-123')['image'], 'https://example.com/result.png')
            provider.assert_not_called()

    def test_uncertain_submit_never_automatically_resubmits(self):
        with patch.object(module, 'provider', side_effect=TimeoutError()) as provider:
            self.jobs.submit(self.inputs)
            self.jobs.submit(self.inputs)
            self.assertEqual(provider.call_count, 1)
        self.assertIn('charged', self.jobs.status('test-123')['error'])

    def test_invalid_images_rejected_before_charging(self):
        for value in ['file:///tmp/a.png', 'http://example.com/a.png', 'blob:https://firefly.adobe.com/a', 'data:image/png;base64,???']:
            with self.subTest(value=value), patch.object(module, 'provider') as provider:
                with self.assertRaises(ValueError):
                    self.jobs.submit({**self.inputs, 'garment': value})
                provider.assert_not_called()

    def test_provider_error_is_terminal(self):
        with patch.object(module, 'provider', return_value=self.handle):
            self.jobs.submit(self.inputs)
        with patch.object(module, 'provider', return_value={'status': 'COMPLETED', 'error': 'bad garment'}):
            self.assertEqual(self.jobs.status('test-123')['state'], 'failed')

    def test_provider_handles_cannot_redirect_credentials(self):
        with patch.object(module, 'provider', return_value={**self.handle, 'status_url': 'https://evil.example/status'}):
            self.assertEqual(self.jobs.submit(self.inputs)['state'], 'failed')
        with self.assertRaises(ValueError):
            module.provider('https://evil.example/status')

    def test_transient_result_error_preserves_existing_paid_job(self):
        with patch.object(module, 'provider', return_value=self.handle):
            self.jobs.submit(self.inputs)
        with patch.object(module, 'provider', side_effect=[{'status': 'COMPLETED'}, ValueError('Temporary HTTP 503')]):
            with self.assertRaises(ValueError):
                self.jobs.status('test-123')
        self.assertEqual(self.jobs.get('test-123')['state'], 'generating')

    def test_rejected_provider_result_allows_explicit_retry(self):
        with patch.object(module, 'provider', return_value=self.handle):
            self.jobs.submit(self.inputs)
        with patch.object(module, 'provider', side_effect=[{'status': 'COMPLETED'}, module.ProviderError(422)]):
            self.assertEqual(self.jobs.status('test-123')['state'], 'failed')

    def test_http_requires_token_and_rejects_web_origins(self):
        handler = module.handler(self.jobs, 'local-test-token')
        request = handler.__new__(handler)
        replies = []
        request.reply = lambda code, data: replies.append((code, data))
        request.headers = {'Authorization': 'Bearer local-test-token', 'Origin': 'https://evil.example'}
        self.assertFalse(request.authorized())
        self.assertEqual(replies[-1][0], 403)
        request.headers = {'Authorization': 'Bearer wrong'}
        self.assertFalse(request.authorized())
        self.assertEqual(replies[-1][0], 401)
        request.headers = {'Authorization': 'Bearer local-test-token', 'Origin': 'chrome-extension://test'}
        self.assertTrue(request.authorized())

    def test_categories_and_data_urls(self):
        self.assertEqual(module.image('data:image/png;base64,YQ=='), 'data:image/png;base64,YQ==')
        with self.assertRaises(ValueError):
            self.jobs.submit({**self.inputs, 'category': 'shoes'})


if __name__ == '__main__':
    unittest.main()
