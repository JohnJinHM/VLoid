import sys
from core.config import load_config
from core.logger import get_logger
from modules.vllm import VLLMModule
from modules.open_webui import WebUIModule

def main():
    logger = get_logger("System")
    logger.info("Loading configuration...")
    config = load_config()
    
    active_modules = []
    
    try:

        vllm = VLLMModule(config)
        vllm.start()
        active_modules.append(vllm)
        
        if config.get("webui", {}).get("enabled", False):
            webui = WebUIModule(config)
            webui.start()
            active_modules.append(webui)

        logger.info("="*40)
        logger.info("🚀 All systems ready. Type 'exit' to terminate.")
        logger.info("="*40)
        
        # Main loop
        while True:
            user_input = input().strip().lower()
            if user_input == 'exit':
                break
                
    except KeyboardInterrupt:
        logger.warning("Keyboard interrupt received.")
        
    finally:
        logger.info("Initiating graceful shutdown...")
        # Stop in reverse order
        for module in reversed(active_modules):
            module.stop()
        sys.exit(0)

if __name__ == "__main__":
    main()