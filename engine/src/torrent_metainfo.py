"""Read a bounded bencoded metainfo document without touching its payload files."""
import hashlib


def read_metainfo(data):
    pos = 0
    count = 0
    digest = None

    def read(depth):
        nonlocal pos, count, digest
        count += 1
        if depth > 80 or count > 500000 or pos >= len(data):
            raise ValueError('种子元数据无效或过大')
        tag = data[pos:pos+1]
        if tag in (b'd', b'l'):
            pos += 1
            value = {} if tag == b'd' else []
            while data[pos:pos+1] != b'e':
                item = read(depth+1)
                if tag == b'l':
                    value.append(item)
                else:
                    if not isinstance(item, bytes) or item in value:
                        raise ValueError('种子字典无效')
                    start = pos
                    value[item] = read(depth+1)
                    if depth == 0 and item == b'info':
                        digest = hashlib.sha1(data[start:pos]).hexdigest()
            pos += 1
            return value
        if tag == b'i':
            end = data.index(b'e', pos+1, pos+24)
            value = int(data[pos+1:end])
            pos = end+1
            return value
        sep = data.index(b':', pos, pos+12)
        if not data[pos:sep].isdigit():
            raise ValueError('种子文件无效')
        end = sep+1+int(data[pos:sep])
        if end > len(data):
            raise ValueError('种子文件不完整')
        pos = end
        return data[sep+1:end]

    document = read(0)
    if pos != len(data) or not digest or not isinstance(document.get(b'info'), dict):
        raise ValueError('种子缺少有效元数据')
    return digest, document[b'info']


def file_listing(info):
    def label(item):
        if not isinstance(item, bytes) or not item:
            raise ValueError('种子文件名无效')
        try:
            return item.decode('utf-8')
        except UnicodeDecodeError:
            return item.decode('gb18030', errors='replace')

    root = label(info.get(b'name.utf-8') or info.get(b'name'))
    files = []

    def add(parts, item):
        length = item.get(b'length')
        if not isinstance(length, int) or length < 0:
            raise ValueError('种子文件大小无效')
        if b'p' not in item.get(b'attr', b''):
            files.append({'path': '/'.join(parts), 'size': length})

    def walk(parts, tree):
        for key, child in tree.items():
            if key == b'':
                add(parts, child)
            else:
                walk([*parts, label(key)], child)

    if b'files' in info:
        for item in info[b'files']:
            parts = item.get(b'path.utf-8') or item[b'path']
            add([root, *map(label, parts)], item)
    elif b'file tree' in info:
        walk([root], info[b'file tree'])
    else:
        add([root], info)
    if not files:
        raise ValueError('种子中没有文件')
    return {'files': files, 'size': sum(f['size'] for f in files)}
