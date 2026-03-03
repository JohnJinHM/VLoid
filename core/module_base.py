import subprocess
import threading
from abc import ABC, abstractmethod
from core.logger import get_logger

class BaseModule(ABC):
    def __init__(self, name, config):
        self.name = name
        self.config = config
        self.logger = get_logger(name)
        self.process = None

    @abstractmethod
    def start(self):
        """Implement the command formulation and startup logic here."""
        pass

    def run_subprocess(self, cmd, env=None):
        """Runs the subprocess and pipes logs to the Python logger."""
        self.logger.info(f"Executing: {cmd}")
        
        # Notice we use subprocess.PIPE instead of CREATE_NEW_CONSOLE
        self.process = subprocess.Popen(
            cmd, 
            shell=True, 
            env=env,
            stdout=subprocess.PIPE, 
            stderr=subprocess.STDOUT, # Merge stderr into stdout
            text=True, 
            bufsize=1,
            encoding="utf-8",
            errors="replace"
        )

        # Start a daemon thread to read logs continuously
        threading.Thread(target=self._log_stream, daemon=True).start()

    def _log_stream(self):
        """Reads the subprocess output line by line."""
        for line in iter(self.process.stdout.readline, ''):
            clean_line = line.strip()
            if clean_line:
                self.logger.info(clean_line)
        self.process.stdout.close()

    def stop(self):
        if self.process:
            self.logger.info(f"Terminating {self.name}...")
            self.process.terminate()
            self.process.wait()
            self.logger.info(f"{self.name} terminated.")