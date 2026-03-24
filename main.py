import sys
from core.config import load_config
from core.logger import get_logger
from modules.vllm import VLLMModule
from modules.open_webui import WebUIModule
from modules.llama_cpp import LlamaCppModule
from modules.api_server import ApiServerModule

def main():
    logger = get_logger("System")
    logger.info("Loading configuration...")
    config = load_config()
    
    active_modules = []
    
    try:
        engine_type = config.get("inference_engine", "llama_cpp")
        
        if engine_type == "vllm":
            engine = VLLMModule(config)
        elif engine_type == "llama_cpp":
            engine = LlamaCppModule(config)
        else:
            logger.error(f"Unknown engine type: {engine_type}")
            return
        
        engine.start()
        active_modules.append(engine)
        
        if config.get("open-webui", {}).get("enabled", False):
            webui = WebUIModule(config)
            webui.start()
            active_modules.append(webui)
        else:
            ApiServerModule(config).start()
            active_modules.append(ApiServerModule(config))

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