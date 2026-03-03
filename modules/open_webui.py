import os
import time
import requests
from core.module_base import BaseModule

class WebUIModule(BaseModule):
    def __init__(self, config):
        super().__init__("WebUI", config)

    def start(self):
        env = os.environ.copy()
        # Force the subprocess to use UTF-8 encoding
        env["PYTHONIOENCODING"] = "utf-8"
        
        env["ENABLE_AUTOINSTALL_FUNCTIONS_DEPENDENCIES"] = "False"
        env["ENABLE_OLLAMA_API"] = "False"
        port = self.config.get("port", 8000)
        env["OPENAI_API_BASE_URLS"] = f"http://127.0.0.1:{port}/v1"
        env["OPENAI_API_KEYS"] = "none"
        env["USER_AGENT"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
        
        # Start the process
        self.run_subprocess("open-webui serve", env=env)
        self.logger.info("Open WebUI starting...")
        
        health_url = f"http://127.0.0.1:8080/health"
        
        # Tip: Add a retry limit so it doesn't loop forever if the process fails
        max_retries = 12  # 60 seconds total
        retries = 0
        
        while retries < max_retries:
            try:
                response = requests.get(health_url, timeout=2)
                if response.status_code == 200:
                    self.logger.info("✅ Open WebUI is ready at http://127.0.0.1:8080")
                    return # Exit the loop successfully
            except requests.exceptions.ConnectionError:
                pass
            
            retries += 1
            time.sleep(5)
            
        self.logger.error("❌ Open WebUI failed to start within 60 seconds.")