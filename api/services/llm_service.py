import httpx
from api.schemas.chat_schema import ChatRequest
from core.logger import get_logger
from core.config import load_config

logger = get_logger("LLMService")

class LLMService:
    def __init__(self):
        self.config = load_config()
        
        llama_cfg = self.config.get("llama_cpp", {})
        host = llama_cfg.get("host", "127.0.0.1")
        port = llama_cfg.get("port", 8080)
        
        self.base_url = f"http://{host}:{port}/v1"
        logger.info(f"LLMService initialized with base_url: {self.base_url}")

    async def generate_chat_completion(self, request: ChatRequest):
        """非流式对话生成"""
        # 在这里可以拦截并修改 messages（例如插入角色设定、历史记忆）
        # payload_messages = MemoryService.inject_memory(request.session_id, request.messages)
        
        payload = {
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "temperature": request.temperature,
            "top_p": request.top_p,
            "max_tokens": request.max_tokens,
            "stream": False
        }
        
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    json=payload,
                    timeout=300.0
                )
                response.raise_for_status()
                return response.json()
            except Exception as e:
                logger.error(f"LLM inference failed: {str(e)}")
                raise

    async def generate_chat_stream(self, request: ChatRequest):
        """流式对话生成 (SSE)"""
        payload = {
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "temperature": request.temperature,
            "top_p": request.top_p,
            "presence_penalty": request.repetition_penalty,
            "max_tokens": request.max_tokens,
            "stream": True
        }
        
        async with httpx.AsyncClient() as client:
            async with client.stream("POST", f"{self.base_url}/chat/completions", json=payload, timeout=300.0) as response:
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        yield f"data: {data_str}\n\n"