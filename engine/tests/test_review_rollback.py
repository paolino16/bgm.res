import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from src.rename import review_rollback as reviews


class ReviewRollbackTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        for name in ('task','record','rename_plans'):(self.root/name).mkdir()
        for name,value in [('DATA_PATH',self.root),('TASK_PATH',self.root/'task'),('RECORD_PATH',self.root/'record')]:
            p=patch.object(reviews,name,value);p.start();self.addCleanup(p.stop)
        self.task,self.plan,self.record,self.snapshot=reviews.paths('task')
        self.old={'uuid':'task','name':'Original','error':None}
        self.old_plan={'revision':'old','state':'completed','rows':[]}
        reviews.atomic_write(self.task,self.old);reviews.atomic_write(self.plan,self.old_plan);reviews.atomic_write(self.record,{'status':'completed','entries':{}})
        self.video=self.root/'video.mkv';self.video.write_bytes(b'unchanged')

    def identify(self):
        reviews.begin('task');reviews.atomic_write(self.task,{'uuid':'task','name':'New','error':'pending'});reviews.atomic_write(self.plan,{'revision':'new','state':'pending','rows':[]});reviews.seal('task')

    def test_cancel_restores_previous_task_plan_and_keeps_record_media(self):
        before=self.record.read_bytes();self.identify();self.assertTrue(reviews.available('task'));result=reviews.cancel('task','new')
        self.assertTrue(result['restored']);self.assertEqual(reviews.read(self.task),self.old);self.assertEqual(reviews.read(self.plan),self.old_plan);self.assertEqual(self.record.read_bytes(),before);self.assertEqual(self.video.read_bytes(),b'unchanged');self.assertFalse(reviews.available('task'))

    def test_multiple_recognitions_keep_the_original_snapshot(self):
        self.identify();reviews.begin('task');reviews.atomic_write(self.task,{'uuid':'task','name':'Third'});reviews.seal('task');reviews.cancel('task');self.assertEqual(reviews.read(self.task),self.old)

    def test_changed_record_and_later_task_edits_block_cancel(self):
        self.identify();reviews.atomic_write(self.record,{'status':'running'});
        with self.assertRaisesRegex(ValueError,'文件操作'):reviews.cancel('task')
        reviews.atomic_write(self.record,{'status':'completed','entries':{}});reviews.atomic_write(self.task,{'uuid':'task','name':'User edit'})
        with self.assertRaisesRegex(ValueError,'另外编辑'):reviews.cancel('task')
        self.assertEqual(reviews.read(self.task)['name'],'User edit')

    def test_old_plan_is_only_discarded_not_falsely_restored(self):
        reviews.atomic_write(self.plan,{'revision':'pending','state':'pending'});result=reviews.cancel('task','pending');self.assertFalse(result['restored']);self.assertEqual(reviews.read(self.task)['name'],'Original');self.assertEqual(reviews.read(self.task)['review_state'],'cancelled');self.assertEqual(reviews.read(self.plan)['state'],'cancelled');self.assertEqual(self.video.read_bytes(),b'unchanged')

    def test_no_previous_plan_is_restored_as_absent(self):
        self.plan.unlink();self.identify();reviews.cancel('task');self.assertFalse(self.plan.exists());self.assertEqual(reviews.read(self.task),self.old)

    def test_interrupted_restore_can_resume_after_task_was_restored(self):
        self.identify();saved=reviews.read(self.snapshot);saved['state']='restoring';reviews.atomic_write(self.snapshot,saved);reviews.atomic_write(self.task,self.old);reviews.cancel('task','new');self.assertEqual(reviews.read(self.plan),self.old_plan)

    def test_executed_or_stale_plan_is_not_cancelled(self):
        self.identify()
        with self.assertRaisesRegex(ValueError,'方案已变化'):reviews.cancel('task','stale')
        reviews.finish('task');reviews.atomic_write(self.plan,{'revision':'new','state':'completed'})
        with self.assertRaisesRegex(ValueError,'没有可放弃'):reviews.cancel('task')
