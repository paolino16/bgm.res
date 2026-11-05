import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from src.desktop_service import Lifecycle, create_app, process_alive, service_lock
from src import integration_api


class LifecycleTests(unittest.TestCase):
    def test_owner_exit_waits_for_running_and_queued_work(self):
        state = Lifecycle()
        state.started -= 31
        state.stop = Mock()
        state.owners.add(os.getpid())
        state.tick()
        state.stop.assert_not_called()
        state.owners.clear()
        for phase in ('queued', 'running'):
            state.jobs = {'job': {'state': phase}}
            state.tick()
            state.stop.assert_not_called()
        state.jobs['job']['state'] = 'completed'
        state.tick()
        state.stop.assert_called_once()

    def test_current_process_is_alive(self):
        self.assertTrue(process_alive(os.getpid()))

    def test_second_service_cannot_acquire_same_data_lock(self):
        with tempfile.TemporaryDirectory() as folder, patch('src.desktop_service.DATA_PATH', Path(folder)):
            with service_lock():
                with self.assertRaises(OSError), service_lock():
                    pass

    def test_shutdown_drains_existing_job_and_rejects_new_actions(self):
        state = Lifecycle()
        state.stop = Mock()
        started, release = threading.Event(), threading.Event()
        def work(action, body):
            started.set()
            release.wait(5)
            return {'done': True}
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(integration_api, 'DATA_PATH', Path(folder)), \
             patch.object(integration_api, 'perform', side_effect=work):
            app = create_app(state)
            headers = {'x-bgm-token': json.loads(Path(folder, 'desktop-api.json').read_text())['token']}
            with TestClient(app) as client:
                self.assertEqual(client.post('/integration/v1/control/shutdown').status_code, 403)
                self.assertEqual(client.post('/integration/v1/control/attach', headers=headers, json={'pid': os.getpid()}).status_code, 200)
                identifier = client.post('/integration/v1/action/config', headers=headers, json={}).json()['job_id']
                self.assertTrue(started.wait(2))
                self.assertEqual(client.post('/integration/v1/control/shutdown', headers=headers).json()['active_jobs'], 1)
                state.tick()
                state.stop.assert_not_called()
                self.assertEqual(client.post('/integration/v1/action/config', headers=headers, json={}).status_code, 503)
                release.set()
                for _ in range(100):
                    job = client.get('/integration/v1/jobs/' + identifier, headers=headers).json()
                    if job['state'] == 'completed':
                        break
                    time.sleep(.01)
                self.assertEqual(job['result'], {'done': True})
                state.tick()
                state.stop.assert_called()



class DesktopImportsTests(unittest.TestCase):
    def test_desktop_service_has_no_retired_browser_ui_dependency(self):
        script = "from src.desktop_service import create_app; create_app(); import sys; assert not any(m == 'nicegui' or m.startswith('nicegui.') or m.startswith('src.pages') for m in sys.modules)"
        result = subprocess.run([sys.executable, '-c', script], cwd=Path(__file__).resolve().parents[1], env=os.environ.copy(), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
