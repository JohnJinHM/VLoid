import uvicorn
import multiprocessing
from core.module_base import BaseModule
from core.logger import get_logger

logger = get_logger("APIServer")

def run_server(host: str, port: int):
    # 使用字符串路径指向 api.app 模块中的 app 实例
    uvicorn.run("api.app:app", host=host, port=port, log_level="warning")

class ApiServerModule(BaseModule):
    def __init__(self, config):
        super().__init__("APIServer", config)
        self.host = self.config.get("api", {}).get("host", "127.0.0.1")
        self.port = self.config.get("api", {}).get("port", 3000)
        self.process = None

    def start(self):
        logger.info(f"Starting FastAPI server on {self.host}:{self.port}...")
        # 建议使用 multiprocessing 启动 uvicorn 以避免阻塞主线程
        self.process = multiprocessing.Process(
            target=run_server, 
            args=(self.host, self.port),
            daemon=True
        )
        self.process.start()

    def stop(self):
        if self.process and self.process.is_alive():
            logger.info("Stopping FastAPI server...")
            self.process.terminate()
            self.process.join()