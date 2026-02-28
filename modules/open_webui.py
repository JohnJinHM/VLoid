import os
import time
import requests
from core.module_base import BaseModule

class WebUIModule(BaseModule):
    def __init__(self, config):
        super().__init__("WebUI", config)

    def start(self):
        env = os.environ.copy()
        env["ENABLE_AUTOINSTALL_FUNCTIONS_DEPENDENCIES"] = "False"
        env["ENABLE_OLLAMA_API"] = "False"
        vllm_port = self.config['vllm']['port']
        env["OPENAI_API_BASE_URLS"] = f"http://127.0.0.1:{vllm_port}/v1"
        env["OPENAI_API_KEYS"] = "none"
        
        self.run_subprocess("open-webui serve", env=env)
        self.logger.info("Open WebUI starting...")
        
        health_url = f"http://127.0.0.1:8080/health"
        while True:
            try:
                response = requests.get(health_url)
                if response.status_code == 200:
                    self.logger.info("✅ Open WebUI is ready at http://127.0.0.1:8080")
                    break
            except requests.exceptions.ConnectionError:
                pass
            time.sleep(5)