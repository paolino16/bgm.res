#!/usr/bin/env python3
"""
AI识别测试脚本 - 重构版本

支持三种测试模式：
1. manual: 手动模式，生成prompt供用户复制给LLM，然后输入LLM响应进行测试
2. auto: 自动模式，完整的AI识别流程，但不实际移动文件，只输出预期操作
3. save: 保存测试用例模式，将动漫信息和本地文件信息保存为JSON格式

使用方法：
python tests/test_ai_recognition.py --mode manual --path "/path/to/anime"
python tests/test_ai_recognition.py --mode auto --path "/path/to/anime" --provider openai
python tests/test_ai_recognition.py --mode save --path "/path/to/anime" --output test_case.json
python tests/test_ai_recognition.py --mode manual --input test_case.json --provider gemini
python tests/test_ai_recognition.py --mode auto --input test_case.json --provider openai --openai_output_format function_calling
"""

import sys
import json
import argparse
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple, Optional

# 添加项目根目录到Python路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.logger import logger
from src.ai.client import AIClient
from src.rename.get_info import Search
from src.config.config_manager import cm
from src.rename.utils import VIDEO_SUFFIX
from src.ai.models import AIAnalysisResult
from src.ai.video_analyzer import VideoAnalyzer
from src.rename.cleaner import (
    remove_tag,
    remove_season,
    divide_by_year,
    remove_episode,
)










def main():
    parser = argparse.ArgumentParser(
        description="AI识别测试脚本 - 支持多种测试模式和AI提供商",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例:
  # 手动模式测试
  python tests/test_ai_recognition.py --mode manual --path "/path/to/anime"

  # 自动模式测试，指定AI提供商
  python tests/test_ai_recognition.py --mode auto --path "/path/to/anime" --provider gemini

  # 保存测试用例
  python tests/test_ai_recognition.py --mode save --path "/path/to/anime" --output test_case.json

  # 从测试用例进行手动测试
  python tests/test_ai_recognition.py --mode manual --input test_case.json --provider gemini

  # 从测试用例进行自动测试
  python tests/test_ai_recognition.py --mode auto --input test_case.json --provider openai --openai_output_format function_calling
        """,
    )

    parser.add_argument(
        "--mode",
        choices=["manual", "auto", "save"],
        required=True,
        help="测试模式: manual(手动), auto(自动), save(保存测试用例)",
    )

    parser.add_argument("--path", help="要测试的动漫文件路径")

    parser.add_argument(
        "--provider",
        choices=["openai", "gemini"],
        help="AI提供商选择 (openai 或 gemini)，不指定则使用配置中的默认值",
    )

    parser.add_argument(
        "--openai_output_format",
        choices=["function_calling", "json_object", "structured_output", "text"],
        help="OpenAI输出格式选择，支持: function_calling, json_object, structured_output, text",
    )

    parser.add_argument("--output", help="保存测试用例的文件路径 (save模式必需)")

    parser.add_argument(
        "--input", help="测试用例JSON文件路径 (与--path二选一，同时指定时优先使用)"
    )

    args = parser.parse_args()

    # 验证参数组合
    if not args.path and not args.input:
        parser.error("必须指定 --path 或 --input 参数之一")

    if args.mode == "save" and args.input:
        parser.error("save 模式不支持 --input 参数，请使用 --path 指定源路径")

    # 确定输入数据源，--input 优先
    if args.input:
        input_path = Path(args.input)
        if not input_path.exists():
            print(f"❌ 错误：测试用例文件不存在: {input_path}")
            return
        path = None
        input_file = args.input
    else:
        path = Path(args.path)
        if not path.exists():
            print(f"❌ 错误：路径不存在: {path}")
            return
        input_file = None

    # 创建测试器
    tester = AIRecognitionTester(
        provider=args.provider, openai_output_format=args.openai_output_format
    )

    # 执行对应模式
    try:
        if args.mode == "manual":
            if input_file:
                tester.manual_mode_from_json(input_file)
            else:
                tester.manual_mode(path)
        elif args.mode == "auto":
            if input_file:
                tester.auto_mode_from_json(input_file)
            else:
                tester.auto_mode(path)
        elif args.mode == "save":
            tester.save_test_case(path, args.output)
    except KeyboardInterrupt:
        print("\n❌ 用户中断操作")
    except Exception as e:
        print(f"❌ 执行过程中发生错误: {e}")
        logger.error(f"测试脚本执行失败: {e}", exc_info=True)


if __name__ == "__main__":
    main()
