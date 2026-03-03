import time
import requests
import os
from core.module_base import BaseModule

class LlamaCppModule(BaseModule):
    def __init__(self, config):
        # We'll use Blue for llama.cpp logs to distinguish from vLLM Green
        super().__init__("llama.cpp", config)

    def start(self):
        cfg = self.config['llama_cpp']
        
        # Build the command for llama-server
        # Make sure llama-server is in your PATH or provide absolute path
        cmd = (
            f"llama-server "
            f"--model \"{cfg['model_path']}\" "
            f"--host {cfg['host']} "
            f"--port {cfg['port']} "
            f"--n-gpu-layers {cfg['n_gpu_layers']} "
            f"--ctx-size {cfg['ctx_size']} "
            f"--threads {cfg['n_threads']} "
            f"--cont-batching"
        )
        
        # Use native Windows execution (no WSL)
        self.run_subprocess(cmd)
        
        # Health check
        health_url = f"http://{cfg['host']}:{cfg['port']}/health"
        self.logger.info(f"Waiting for llama.cpp to initialize on port {cfg['port']}...")
        
        while True:
            try:
                # llama-server returns 200 OK at /health when ready
                response = requests.get(health_url)
                if response.status_code == 200:
                    self.logger.info("✅ llama.cpp is ready!")
                    break
            except requests.exceptions.ConnectionError:
                pass
            time.sleep(3)

    def stop(self):
        # llama.cpp stops cleanly with a simple terminate
        super().stop()