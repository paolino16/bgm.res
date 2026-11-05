import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import Mock, patch

from src.ai import bangumi_deepseek as ai
from src.rename import plan_resolution as plans
from src import integration_api


class DeepSeekReviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for module, key, value in ((ai, 'DATA_PATH', self.root), (plans, 'PLAN_PATH', self.root / 'plans')):
            self.enterContext(patch.object(module, key, value))
        self.enterContext(patch.object(ai.cm, 'get_config', side_effect=lambda key: 'test-key-never-log' if key.endswith('api_key') else ''))
        self.seal = self.enterContext(patch('src.rename.review_rollback.seal'))
        self.enterContext(patch.object(plans, 'desktop_review_plan', side_effect=plans.load_plan))
        self.client = Mock()
        self.client_factory = Mock(return_value=self.client)
        self.plan = {'uuid': 'one', 'revision': 'r1', 'state': 'pending', 'root': str(self.root / 'source'),
                     'context': {'layout': 'bangumi', 'subject_id': '123', 'name': 'Show',
                                 'episodes': [{'id': 101, 'type': 0, 'sort': 1, 'name': 'First'},
                                              {'id': 102, 'type': 1, 'sort': 1, 'name': 'Special'}]},
                     'rows': [{'source': str(self.root / 'source' / 'Show 01.mkv'), 'category': 'unresolved',
                               'episode_id': None, 'subject_id': '123', 'filename': '', 'version': ''}]}
        plans._write(plans._path('one'), self.plan)

    def item(self, index=0, **changes):
        return {'file': index, 'category': 'episode', 'subject_id': '123', 'episode_id': 101,
                'confidence': 'High', 'reason': '独立集号01，对应正片章节', **changes}

    def response(self, items=None, *, finish='stop'):
        return NS(usage=NS(prompt_tokens=2000, completion_tokens=500),
                  choices=[NS(finish_reason=finish, message=NS(content=json.dumps({'mappings': items or [self.item()]})))])

    def run_review(self, rows=None, scope='unresolved'):
        return ai.review_plan('one', 'r1', copy.deepcopy(rows or self.plan['rows']), scope, client_factory=self.client_factory)

    def test_valid_result_changes_only_pending_plan_and_accounts_usage(self):
        video = Path(self.plan['rows'][0]['source'])
        video.parent.mkdir(); video.write_bytes(b'original media')
        self.client.chat.completions.create.return_value = self.response()
        result = self.run_review()
        self.assertEqual(result['draft_rows'][0]['episode_id'], 101)
        self.assertNotEqual(result['revision'], 'r1')
        self.assertEqual(result['ai_review']['estimated_cny'], .008)
        self.assertEqual(result['rows'][0]['episode_id'], None)
        self.assertEqual(video.read_bytes(), b'original media')
        params = self.client.chat.completions.create.call_args.kwargs
        self.assertEqual(params['model'], 'deepseek-flash')
        self.assertEqual(params['max_tokens'], 8000)
        self.assertEqual(params['extra_body']['thinking']['type'], 'disabled')
        self.assertNotIn(str(self.root), params['messages'][1]['content'])
        self.seal.assert_called_once_with('one')
        audit = next((self.root / 'ai_analysis').rglob('*.json')).read_text()
        self.assertNotIn('test-key-never-log', audit)
        self.assertEqual(json.loads(audit)['state'], 'completed')

    def test_low_confidence_revokes_automatic_mapping_for_review(self):
        self.plan['rows'][0].update(episode_id=101, category='episode')
        plans._write(plans._path('one'), self.plan)
        self.client.chat.completions.create.return_value = self.response([self.item(confidence='Low')])
        result = self.run_review(scope='all')
        self.assertIsNone(result['draft_rows'][0]['episode_id'])
        self.assertEqual(result['draft_rows'][0]['category'], 'unresolved')

    def test_explicit_edits_and_skips_are_protected(self):
        for changes in ({'episode_id': 102}, {'manual_mapping': True}, {'skip': True}, {'filename': 'My Movie'}):
            rows = copy.deepcopy(self.plan['rows']); rows[0].update(changes)
            self.assertEqual(ai.eligible_rows(self.plan, rows, 'all'), [])
        with self.assertRaises(ValueError):
            self.run_review(rows=rows, scope='all')
        self.client_factory.assert_not_called()

    def test_invalid_ids_duplicates_and_missing_rows_are_rejected(self):
        subjects = {'123': self.plan['context']}
        bad = [[self.item(episode_id=999)], [self.item(subject_id='999')], [self.item(index=9)],
               [self.item(), self.item()], [], [self.item(category='extra')], [self.item(confidence='sure')]]
        for items in bad:
            with self.subTest(items=items), self.assertRaises(ValueError):
                ai.validate_output(json.dumps({'mappings': items}), [0], subjects)

    def test_invalid_response_has_three_attempts_and_preserves_original(self):
        self.client.chat.completions.create.return_value = self.response([self.item(episode_id=999)])
        with self.assertRaises(ValueError):
            self.run_review()
        self.assertEqual(self.client.chat.completions.create.call_count, 3)
        self.assertEqual(plans.load_plan('one'), self.plan)
        audit = json.loads(next((self.root / 'ai_analysis').rglob('*.json')).read_text())
        self.assertEqual(audit['state'], 'failed')
        self.assertEqual(audit['reserved_cny'], .384)
        self.assertEqual(audit['estimated_cny'], .024)

    def test_timeout_stops_without_repeating_paid_request_and_reports_progress(self):
        import httpx
        from openai import APITimeoutError
        self.client.chat.completions.create.side_effect = APITimeoutError(request=httpx.Request('POST', 'https://api.deepseek.com/chat/completions'))
        progress = Mock()
        with self.assertRaisesRegex(ValueError, '请求超时'):
            ai.review_plan('one', 'r1', copy.deepcopy(self.plan['rows']), client_factory=self.client_factory, progress=progress)
        self.assertEqual(self.client.chat.completions.create.call_count, 1)
        self.assertEqual(plans.load_plan('one'), self.plan)
        self.assertIn('第 1/1 批', progress.call_args.args[0])
        audit = json.loads(next((self.root / 'ai_analysis').rglob('*.json')).read_text())
        self.assertEqual(audit['state'], 'failed')
        self.assertEqual(audit['attempts'][0]['error'], 'request_timeout')
        self.assertIn('elapsed_seconds', audit['attempts'][0])
        self.client.close.assert_called_once()

    def test_authentication_error_does_not_retry_or_expose_key(self):
        error = Exception('test-key-never-log'); error.status_code = 401
        self.client.chat.completions.create.side_effect = error
        with self.assertRaisesRegex(ValueError, 'HTTP 401') as caught:
            self.run_review()
        self.assertNotIn('test-key-never-log', str(caught.exception))
        self.assertEqual(self.client.chat.completions.create.call_count, 1)

    def test_oversize_and_stale_plan_are_rejected_before_api(self):
        rows = copy.deepcopy(self.plan['rows']); rows[0]['source'] += 'x' * 31000
        self.plan['rows'] = rows; plans._write(plans._path('one'), self.plan)
        with self.assertRaisesRegex(ValueError, '输入超过'):
            self.run_review()
        self.client_factory.assert_not_called()
        self.plan['revision'] = 'new'; plans._write(plans._path('one'), self.plan)
        with self.assertRaises(ValueError):
            self.run_review()

    def test_truncated_response_retries_then_succeeds(self):
        self.client.chat.completions.create.side_effect = [self.response(finish='length'), self.response()]
        result = self.run_review()
        self.assertEqual(result['ai_review']['attempts'], 2)
        self.assertEqual(result['ai_review']['estimated_cny'], .016)

    def test_changed_plan_during_request_does_not_get_overwritten(self):
        def change(**kwargs):
            newer = copy.deepcopy(self.plan); newer['revision'] = 'newer'
            plans._write(plans._path('one'), newer)
            return self.response()
        self.client.chat.completions.create.side_effect = change
        with self.assertRaisesRegex(ValueError, '方案已变化'):
            self.run_review()
        self.assertEqual(plans.load_plan('one')['revision'], 'newer')

    def test_second_batch_failure_does_not_apply_first_batch(self):
        self.plan['rows'] = [{**self.plan['rows'][0], 'source': str(self.root / 'source' / f'{i}.mkv')}
                             for i in range(51)]
        plans._write(plans._path('one'), self.plan)
        first = self.response([self.item(i) for i in range(50)])
        invalid = self.response([self.item(50, episode_id=999)])
        self.client.chat.completions.create.side_effect = [first, invalid, invalid, invalid]
        with self.assertRaises(ValueError):
            self.run_review()
        self.assertEqual(plans.load_plan('one'), self.plan)
        self.assertEqual(self.client.chat.completions.create.call_count, 4)

    def test_two_full_batches_with_retries_remain_within_budget(self):
        self.plan['rows'] = [{**self.plan['rows'][0], 'source': str(self.root / 'source' / f'{i}.mkv')}
                             for i in range(100)]
        plans._write(plans._path('one'), self.plan)
        invalid = self.response([self.item(episode_id=999)])
        self.client.chat.completions.create.side_effect = [invalid, invalid,
            self.response([self.item(i) for i in range(50)]), invalid, invalid,
            self.response([self.item(i) for i in range(50, 100)])]
        result = self.run_review()
        self.assertEqual(result['ai_review']['attempts'], 6)
        self.assertEqual(result['ai_review']['reserved_cny'], .768)
        self.assertLessEqual(result['ai_review']['reserved_cny'], ai.RUN_BUDGET_CNY)

    def test_manual_custom_filename_protected_after_prior_ai_review(self):
        rows = copy.deepcopy(self.plan['rows'])
        rows[0].update(ai={'provider': 'deepseek'}, filename='custom')
        self.assertEqual(ai.eligible_rows(self.plan, rows, 'all'), [])

    def test_gift_model_uses_low_reasoning_and_list_price_without_claiming_zero_bill(self):
        self.client.chat.completions.create.return_value = self.response()
        with patch.object(ai.cm, 'get_config', side_effect=lambda key: '2099-12-03T23:16:08+08:00' if key=='glm_gift_expires' else 'test-key-never-log'):
            result = ai.review_plan('one', 'r1', copy.deepcopy(self.plan['rows']), model='glm-5.3-flash', client_factory=self.client_factory)
        params = self.client.chat.completions.create.call_args.kwargs
        self.assertEqual(params['model'], 'glm-5.3-flash')
        self.assertEqual(params['extra_body']['reasoning_effort'], 'low')
        self.assertEqual(params['extra_body']['thinking']['type'], 'enabled')
        self.assertEqual(result['ai_review']['billing'], 'gift')
        self.assertAlmostEqual(result['ai_review']['estimated_cny'], .003)

    def test_glm_uses_only_its_own_key_and_official_endpoint(self):
        self.client.chat.completions.create.return_value = self.response()
        config={'bigmodel_api_key':'glm-private', 'deepseek_api_key':'deepseek-private'}
        with patch.object(ai.cm, 'get_config', side_effect=lambda key:config.get(key,'')), patch.object(ai, '_client', return_value=self.client) as factory:
            ai.review_plan('one','r1',copy.deepcopy(self.plan['rows']),model='glm-4-flash-250414')
        factory.assert_called_once_with('glm-private','https://open.bigmodel.cn/api/paas/v4/')
        audit=next((self.root/'ai_analysis').rglob('*.json')).read_text()
        self.assertNotIn('glm-private',audit)
        self.assertNotIn('deepseek-private',audit)

    def test_expired_gift_stops_before_sending_and_free_model_remains_available(self):
        with patch.object(ai.cm, 'get_config', return_value='2020-01-01T00:00:00+08:00'):
            with self.assertRaisesRegex(ValueError, '已到期'):
                ai.review_plan('one', 'r1', copy.deepcopy(self.plan['rows']), model='glm-5.3-flash', client_factory=self.client_factory)
        self.client_factory.assert_not_called()
        self.client.chat.completions.create.return_value = self.response()
        result = ai.review_plan('one', 'r1', copy.deepcopy(self.plan['rows']), model='glm-4-flash-250414', client_factory=self.client_factory)
        self.assertEqual(result['ai_review']['estimated_cny'], 0)
        self.assertEqual(result['ai_review']['billing'], 'free')

    def test_configuration_never_returns_saved_deepseek_key(self):
        with patch.object(ai.cm, 'config', {'deepseek_api_key': 'private', 'bigmodel_api_key':'glm-private'}):
            config = integration_api.perform('config', {})
        self.assertEqual(config['deepseek_api_key'], '')
        self.assertTrue(config['deepseek_key_configured'])
        self.assertEqual(config['bigmodel_api_key'], '')
        self.assertTrue(config['bigmodel_key_configured'])


if __name__ == '__main__':
    unittest.main()
