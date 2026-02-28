import yaml
import os

def load_config(config_path="configs/default_config.yaml"):
    """Loads configuration, falling back to local_config.yaml if it exists."""
    local_path = config_path.replace("default_", "local_")
    path_to_load = local_path if os.path.exists(local_path) else config_path
    
    with open(path_to_load, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)