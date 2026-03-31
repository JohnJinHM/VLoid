import logging
import sys
import os

# Enable ANSI escape sequences for older Windows terminals
if os.name == 'nt':
    os.system('')

# Force UTF-8 encoding for standard output to fix Windows charmap errors
if sys.stdout.encoding.lower() != 'utf-8':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

class ColorFormatter(logging.Formatter):
    """Custom formatter to add ANSI colors based on the module name and log level."""
    
    COLORS = {
        "System": "\033[96m",  # Cyan
        "vLLM": "\033[92m",    # Green
        "llama.cpp": "\033[36m", # Blue
        "WebUI": "\033[95m",   # Magenta
        "WARNING": "\033[93m", # Yellow
        "ERROR": "\033[91m",   # Red
        "LLMService": "\033[95m", # Magenta
        "TTSService": "\033[95m",
        "TTSRouter": "\033[95m",
        "APIServer": "\033[96m", # Cyan
        "App": "\033[92m", # Green
        "Electron": "\033[94m", # Blue
        "RESET": "\033[0m"
    }

    def format(self, record):
        # Format the timestamp
        log_time = self.formatTime(record, self.datefmt)
        
        # Get colors, defaulting to RESET if the module isn't strictly defined
        module_color = self.COLORS.get(record.name, self.COLORS["RESET"])
        level_color = self.COLORS.get(record.levelname, self.COLORS["RESET"])
        
        # Build the padded, colorized string
        formatted_message = (
            f"{log_time} | "
            f"{module_color}{record.name: <10}{self.COLORS['RESET']} | "
            f"{level_color}{record.levelname: <7}{self.COLORS['RESET']} | "
            f"{record.getMessage()}"
        )
        return formatted_message

def get_logger(name):
    logger = logging.getLogger(name)
    
    # Prevent adding multiple handlers if the logger is requested multiple times
    if not logger.handlers:
        logger.setLevel(logging.DEBUG)
        
        # 1. Console handler (Colorized)
        ch = logging.StreamHandler(sys.stdout)
        ch.setFormatter(ColorFormatter())
        logger.addHandler(ch)
        
        # 2. File handler (Plain text, UTF-8 enforced)
        # Using utf-8 here prevents the same charmap error from crashing file writes
        fh = logging.FileHandler("vloid_backend.log", encoding="utf-8")
        plain_formatter = logging.Formatter('%(asctime)s | %(name)-10s | %(levelname)-6s | %(message)s')
        fh.setFormatter(plain_formatter)
        logger.addHandler(fh)
        
    return logger