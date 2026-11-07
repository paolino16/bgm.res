import tempfile
from pathlib import Path
import unittest
from src.rename.release_group import release_group
from src.rename.process import Rename


class ReleaseGroupTests(unittest.TestCase):
    def test_clannad_signer_after_technical_block(self):
        title = 'Clannad Movie 2007 [DVD 720x480p AVC FLAC] - mawen1250'
        self.assertEqual(release_group(title), 'mawen1250')
        self.assertEqual(release_group(title + '.mkv'), 'mawen1250')

    def test_trailing_bracket_signer_after_bdrip(self):
        for suffix in ('', '.mkv'):
            self.assertEqual(release_group('[BDrip] Awajima Hyakkei S01 [7³ACG]' + suffix), '7³ACG')
        self.assertEqual(release_group('[BDRip] Show 【7³ACG】'), '7³ACG')
        for label in ('1080p', 'ABCDEF12', '01', 'NCOP', 'SP01'):
            self.assertEqual(release_group(f'[BDrip] Show [{label}]'), '')
        self.assertEqual(release_group('Show [AfterStory]'), '')

    def test_metadata_is_not_a_group(self):
        for name in ('Clannad [BluRay&DVD x264-Hi10P FLAC]',
                     '[1080p] Clannad', '[01] Clannad', '[ABCDEF12] Clannad',
                     '[NCOP] Clannad', 'Clannad - AfterStory'):
            with self.subTest(name=name):
                self.assertEqual(release_group(name), '')

    def test_leading_groups_and_punctuation(self):
        for group in ('VCB-Studio', 'XKsub&SweetSub&VCB-Studio', 'Moozzi2', 'ANi'):
            self.assertEqual(release_group(f'[{group}] Minami-ke [Ma10p_1080p]'), group)

    def test_file_evidence_and_conflicting_groups(self):
        worker = Rename.__new__(Rename)
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'Clannad [BluRay x264 FLAC]'
            folder.mkdir()
            (folder / '[VCB-Studio] Clannad [01].mkv').touch()
            self.assertEqual(worker.get_subtitle_group(folder), 'VCB-Studio')
            (folder / '[OtherGroup] Clannad [02].mkv').touch()
            self.assertEqual(worker.get_subtitle_group(folder), '')

    def test_retry_discards_old_encoding_group_but_keeps_user_group(self):
        worker = Rename.__new__(Rename)
        path = Path('Clannad Movie 2007 [DVD 720x480p AVC FLAC] - mawen1250')
        self.assertEqual(worker.resolve_subtitle_group(path, 'DVD 720x480p AVC FLAC'), 'mawen1250')
        self.assertEqual(worker.resolve_subtitle_group(path, 'MyGroup'), 'MyGroup')
