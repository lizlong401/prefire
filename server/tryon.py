"""Local Prefire bridge to fal FASHN. Python 3.10+, no dependencies."""
import base64
from contextlib import contextmanager
import json
import os
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ENDPOINT = 'https://queue.fal.run/fal-ai/fashn/tryon/v1.6'
MAX_BODY = 4 * 1024 * 1024


def image(value):
    if not isinstance(value, str) or len(value) > 3 * 1024 * 1024:
        raise ValueError('Image must be an HTTPS URL or a PNG/JPEG/WebP data URL (maximum 3 MB).')
    if value.startswith(('data:image/jpeg;base64,', 'data:image/png;base64,', 'data:image/webp;base64,')):
        try:
            if not base64.b64decode(value.split(',', 1)[1], validate=True):
                raise ValueError()
        except ValueError:
            raise ValueError('Invalid image data.') from None
    elif not (urllib.parse.urlsplit(value).scheme == 'https' and urllib.parse.urlsplit(value).hostname):
        raise ValueError('Image URL must use HTTPS. Upload private or blob images as files.')
    return value


class ProviderError(ValueError):
    def __init__(self, status):
        self.status = status
        super().__init__(f'Generation provider returned HTTP {status}. Check your fal account and image inputs.')


def provider(url, method='GET', payload=None):
    # Never forward credentials to a URL supplied by the browser or a different host.
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'queue.fal.run' or not parsed.path.startswith('/fal-ai/'):
        raise ValueError('Invalid provider URL.')
    key = os.environ.get('FAL_KEY', '')
    if not key:
        raise ValueError('Start the local service with FAL_KEY set.')
    request = urllib.request.Request(url, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': 'Key ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Keep credentials, signed source URLs, and provider request bodies out of errors.
        raise ProviderError(error.code) from None


class Jobs:
    def __init__(self, database):
        self.database = str(database)
        self.lock = threading.Lock()
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT, handle TEXT, result TEXT, error TEXT, created REAL)')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, job_id):
        with self.connect() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        if not row:
            raise KeyError('Job not found.')
        return dict(row)

    def update(self, job_id, state, handle=None, result=None, error=None):
        with self.connect() as db:
            db.execute('UPDATE jobs SET state=?, handle=COALESCE(?,handle), result=?, error=? WHERE id=?',
                       (state, json.dumps(handle) if handle else None, result, error, job_id))

    def submit(self, data):
        job_id = data.get('id', '')
        if not isinstance(job_id, str) or not 1 <= len(job_id) <= 100 or not all(c.isalnum() or c == '-' for c in job_id):
            raise ValueError('Invalid job ID.')
        category = data.get('category', 'auto')
        if category not in ['auto', 'tops', 'bottoms', 'one-pieces']:
            raise ValueError('Invalid garment category.')
        payload = {'model_image': image(data.get('model')), 'garment_image': image(data.get('garment')),
                   'category': category, 'num_samples': 1, 'mode': 'balanced', 'output_format': 'png'}
        if not os.environ.get('FAL_KEY'):
            raise ValueError('Start the local service with FAL_KEY set.')
        # Persist BEFORE submitting. Repeating the client ID never creates a second paid request.
        with self.lock, self.connect() as db:
            row = db.execute('SELECT id FROM jobs WHERE id=?', (job_id,)).fetchone()
            if row:
                return {'id': job_id, 'state': self.get(job_id)['state']}
            db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?)', (job_id, 'submitting', None, None, None, time.time()))
        try:
            handle = provider(ENDPOINT, 'POST', payload)
            for field in ['status_url', 'response_url']:
                url = urllib.parse.urlsplit(handle[field])
                if url.scheme != 'https' or url.netloc != 'queue.fal.run' or not url.path.startswith('/fal-ai/'):
                    raise ValueError('Invalid provider handle.')
            self.update(job_id, 'generating', handle=handle)
        except Exception:
            # A lost submit response might still incur a charge. Never automatically resubmit.
            self.update(job_id, 'failed', error='Submission could not be confirmed. Check fal request history before retrying; it may have been charged.')
        return {'id': job_id, 'state': self.get(job_id)['state']}

    def status(self, job_id):
        job = self.get(job_id)
        if job['state'] == 'submitting' and time.time() - job['created'] > 60:
            self.update(job_id, 'failed', error='Submission interrupted. Check fal request history before retrying.')
            job = self.get(job_id)
        if job['state'] == 'generating':
            handle = json.loads(job['handle'])
            status = provider(handle['status_url'])
            if status.get('status') == 'COMPLETED':
                if status.get('error'):
                    self.update(job_id, 'failed', error='Provider could not generate this item. Check the garment and model images.')
                else:
                    try:
                        result = provider(handle['response_url'])
                    except ProviderError as error:
                        if error.status != 422:
                            raise
                        self.update(job_id, 'failed', error='Provider rejected this generation. Check your garment and model images before retrying.')
                        return self.status(job_id)
                    try:
                        output = image(result['images'][0]['url'])
                        self.update(job_id, 'completed', result=output)
                    except (KeyError, IndexError, ValueError) as error:
                        self.update(job_id, 'failed', error=str(error))
                job = self.get(job_id)
        return {'id': job_id, 'state': job['state'], 'image': job['result'], 'error': job['error']}


def handler(jobs, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, code, data):
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            # Called by the extension worker, not page fetch. No browser CORS access.
            if self.headers.get('Origin') not in (None, 'null') and not self.headers.get('Origin', '').startswith('chrome-extension://'):
                self.reply(403, {'error': 'Use the Prefire extension.'})
                return False
            if not secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.reply(401, {'error': 'Local service token is missing or incorrect.'})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            try:
                if self.path == '/health':
                    return self.reply(200, {'ready': bool(os.environ.get('FAL_KEY')), 'provider': 'fal / FASHN v1.6'})
                if self.path.startswith('/jobs/') and '?' not in self.path:
                    return self.reply(200, jobs.status(self.path.removeprefix('/jobs/')))
                self.reply(404, {'error': 'Not found.'})
            except KeyError:
                self.reply(404, {'error': 'Job not found. Keep the service database when restarting.'})
            except Exception as error:
                self.reply(502, {'error': str(error) if isinstance(error, ValueError) else 'Provider unavailable. Resume to check again.'})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != '/jobs':
                return self.reply(404, {'error': 'Not found.'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= MAX_BODY:
                    return self.reply(413, {'error': 'Request too large (maximum 4 MB).'})
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError('Expected an object.')
                self.reply(200, jobs.submit(data))
            except (ValueError, TypeError):
                self.reply(400, {'error': 'Invalid inputs, or FAL_KEY is missing. Use HTTPS images or uploaded PNG/JPEG/WebP files.'})
            except Exception:
                self.reply(502, {'error': 'Service could not save the job. Check the database and resume.'})
    return Handler


if __name__ == '__main__':
    database = Path(os.environ.get('PREFIRE_DB', str(Path(__file__).with_name('jobs.sqlite3'))))
    token = os.environ.get('PREFIRE_TOKEN') or secrets.token_urlsafe(32)
    httpd = ThreadingHTTPServer(('127.0.0.1', 8765), handler(Jobs(database), token))
    print('Prefire Try-on: http://127.0.0.1:8765', flush=True)
    print('Paste this local service token into Prefire Settings: ' + token, flush=True)
    if not os.environ.get('FAL_KEY'):
        print('FAL_KEY is missing. Set it before starting to enable generation.', flush=True)
    httpd.serve_forever()
