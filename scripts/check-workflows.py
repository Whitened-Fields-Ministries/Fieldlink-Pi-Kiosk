#!/usr/bin/env python3
"""Parse workflow YAML the way GitHub does: duplicate mapping keys are an error
(PyYAML would silently keep the last one, and GitHub refuses the whole file)."""
import sys
import yaml


class StrictLoader(yaml.SafeLoader):
    pass


def construct_mapping(loader, node):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node)
        if key in mapping:
            raise ValueError(f"duplicate key {key!r} at line {key_node.start_mark.line + 1}")
        mapping[key] = loader.construct_object(value_node)
    return mapping


StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping)

status = 0
for path in sys.argv[1:]:
    try:
        with open(path) as fh:
            yaml.load(fh, Loader=StrictLoader)
        print(f"{path}: ok")
    except Exception as exc:  # noqa: BLE001
        print(f"{path}: {exc}")
        status = 1
sys.exit(status)
