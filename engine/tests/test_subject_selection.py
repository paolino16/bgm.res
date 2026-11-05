import unittest
from src.rename.subject_selection import subject_ids, unresolved_bindings


class SelectionTests(unittest.TestCase):
    def test_ids_are_validated_and_deduplicated(self):
        self.assertEqual(subject_ids(['00123', 456, '123']), ['123', '456'])
        for value in ('123,456', [True], ['-1'], ['１'], ['0'], ['bad'], list(range(1, 22))):
            with self.subTest(value=value), self.assertRaises(ValueError):
                subject_ids(value)

    def test_clearing_assignment_preserves_source_evidence(self):
        original = {'source': 'TV/01.mkv', 'subject_id': '123', 'episode_id': 101, 'episode_ids': [101],
                    'category': 'episode', 'recognition': {'evidence': ['01']}}
        result = unresolved_bindings([original])[0]
        self.assertEqual(result['subject_id'], '')
        self.assertEqual(result['recognition'], original['recognition'])
        self.assertEqual(original['episode_id'], 101)
