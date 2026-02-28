import time
import requests
from core.module_base import BaseModule

class VLLMModule(BaseModule):
    def __init__(self, config):
        super().__init__("vLLM", config)

    def start(self):
        sys_cfg = self.config['system']
        vllm_cfg = self.config['vllm']
        
        vllm_cmd = (
            f"cd {sys_cfg['project_dir']} && uv run vllm serve "
            f"'{vllm_cfg['model']}' "
            f"--tensor-parallel-size {vllm_cfg['tensor_parallel_size']} "
            f"--max-model-len {vllm_cfg['max_model_len']} "
            f"--reasoning-parser qwen3 "
            f"--enable-auto-tool-choice "
            f"--tool-call-parser qwen3_coder "
            f"--gpu-memory-utilization {vllm_cfg['gpu_memory_utilization']} "
            f"--enforce-eager "
            f"--host {vllm_cfg['host']} "
            f"--port {vllm_cfg['port']}"
        )
        
        full_cmd = f'wsl -d {sys_cfg["wsl_distro"]} bash -ic "{vllm_cmd}"'
        self.run_subprocess(full_cmd)
        
        # Health check
        health_url = f"http://127.0.0.1:{vllm_cfg['port']}/health"
        self.logger.info("Waiting for vLLM startup...")
        
        while True:
            try:
                response = requests.get(health_url)
                if response.status_code == 200:
                    self.logger.info("✅ vLLM is ready!")
                    break
            except requests.exceptions.ConnectionError:
                pass
            time.sleep(5)
            
    def stop(self):
        super().stop()
        # Fallback to shut down the WSL instance as in your original code
        distro = self.config['system']['wsl_distro']
        self.logger.info(f"Shutting down WSL instance: {distro}")
        import subprocess
        subprocess.run(f"wsl -t {distro}", shell=True)