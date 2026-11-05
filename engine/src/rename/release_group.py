"""Release-group evidence without mistaking encoding tags for group names."""
import re

from .release_parser import TECH, EXPLICIT, content_marker, CREDITLESS
from .utils import VIDEO_SUFFIX


def technical_group(value):
    return bool(TECH.search(value) or re.search(r'(?i)(?<![a-z])blu[- ]?ray(?![a-z])', value))


def valid_group(value):
    return bool(value and not technical_group(value)
                and not re.fullmatch(r'(?i)\d+(?:\.\d+)?(?:v\d+)?|[0-9a-f]{8}|SP|Special|NCOP|NCED|OP|ED|PV|OVA|OAD|Menu', value)
                and not EXPLICIT.search(value) and not content_marker('[' + value + ']')
                and not CREDITLESS.search(value))


def release_group(name):
    # Folder names can contain dots: only remove recognized video extensions.
    for extension in VIDEO_SUFFIX:
        if name.lower().endswith(extension.lower()):
            name = name[:-len(extension)]
            break
    leading = re.match(r'^\s*(?:\[([^\]]+)\]|【([^】]+)】)', name)
    if leading:
        value = next(v for v in leading.groups() if v is not None).strip()
        if valid_group(value) and name[leading.end():].strip():
            return value
    # A trailing single-token signer after technical metadata is release
    # evidence; a plain "Title - Subtitle" alone is not.
    trailing = re.search(r'\s+-\s+([\w][\w.&+\-]*)\s*$', name)
    if trailing and technical_group(name[:trailing.start()]):
        value = trailing.group(1)
        if valid_group(value):
            return value
    return ''
