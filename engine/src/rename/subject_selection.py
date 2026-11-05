"""Explicit multi-subject selections; never infer ownership from list order."""
def subject_ids(value):
    if not isinstance(value, list) or len(value) > 20:
        raise ValueError('归属作品必须是最多二十个 Bangumi ID 的列表')
    result = []
    for item in value:
        text = str(item).strip()
        if not text.isascii() or not text.isdigit() or int(text) <= 0:
            raise ValueError('归属作品包含无效的 Bangumi ID')
        normalized = str(int(text))
        if normalized not in result:
            result.append(normalized)
    return result


def unresolved_bindings(bindings):
    return [{**binding, 'subject_id': '', 'episode_id': None, 'episode_ids': [],
             'episode_type': None, 'category': 'unresolved'} for binding in bindings]
