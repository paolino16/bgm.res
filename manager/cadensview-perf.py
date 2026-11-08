"""Run with CadensView's bundled worker Python; never modifies a user project."""
import argparse
import hashlib
import json
from pathlib import Path
import time

import av
from av.video.reformatter import VideoReformatter
import t0.media as media


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--index', required=True)
    parser.add_argument('--mode', choices=['pipeline', 'index', 'detect'], default='pipeline')
    parser.add_argument('--threads', type=int, default=8)
    parser.add_argument('--frames', type=int, default=4000)
    parser.add_argument('--hw', default='')
    parser.add_argument('--output')
    args = parser.parse_args()
    index = media.FrameIndex.load(args.index)
    limit = min(args.frames, len(index.pts)) if args.frames else len(index.pts)

    def configure(stream):
        stream.thread_type = 'AUTO'
        stream.codec_context.thread_count = args.threads
    media.configure_video_decoder = configure
    started = time.perf_counter()
    result = dict(mode=args.mode, threads=args.threads, hw=args.hw, frames=limit)
    if args.mode == 'index':
        generated = media.build_index(index.path, limit=None if not args.frames else limit)
        assert generated.pts == index.pts[:limit]
        assert generated.durations == index.durations[:limit]
        assert generated.keys == [key for key in index.keys if key < limit]
        assert generated.time_base == index.time_base
        result.update(seconds=generated.elapsed, exact=True)
    elif args.mode == 'pipeline':
        digest = hashlib.sha256()
        if args.hw:
            hw = av.codec.hwaccel.HWAccel(args.hw, allow_software_fallback=False)
            with av.open(index.path, hwaccel=hw) as container:
                stream = container.streams.video[0]
                configure(stream)
                formatter = VideoReformatter()
                for number, frame in enumerate(container.decode(stream)):
                    if number == limit:
                        break
                    assert frame.pts == index.pts[number]
                    pixels = formatter.reformat(frame, width=48, height=27, format='rgb24', interpolation='BILINEAR').to_ndarray()
                    digest.update(pixels.tobytes())
        else:
            from shotlab.detection.core import FrameSource
            source = FrameSource(index)
            for number, pixels in source.frames(0, limit, 48, 27):
                digest.update(pixels.tobytes())
            result.update(decode_seconds=source.decode_seconds, resize_seconds=source.resize_seconds)
        result.update(seconds=time.perf_counter()-started, pixels_sha256=digest.hexdigest())
    else:
        from shotlab.detection.core import run
        from shotlab.detection.onnx import OnnxDetector
        import sys
        detector = OnnxDetector(Path(sys.executable).parent/'models/transnet-split.onnx', device='dml')
        detected = run(index, detector, end=limit)
        result.update(seconds=time.perf_counter()-started, timing=detected.timing,
                      boundaries=[boundary.frame for boundary in detected.boundaries],
                      scores_sha256={key:hashlib.sha256(value.tobytes()).hexdigest() for key, value in detected.scores.items()})
    encoded = json.dumps(result, ensure_ascii=False)
    print(encoded, flush=True)
    if args.output:
        with open(args.output, 'a', encoding='utf-8') as output:
            output.write(encoded+'\n')


if __name__ == '__main__':
    main()
