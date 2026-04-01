# VLoid

## Overview
This project is a locally deployed, multimodal real-time interactive AI assistant powered by Large Language Models (LLMs). The core system is built around real-time visual recognition and Text-to-Speech (TTS) capabilities, enabling the assistant to capture screen content (video streams or screenshots) and provide low-latency audio and text feedback.

Utilizing a decoupled frontend-backend architecture, this project aims to deliver a high-performance inference environment with extensive scalability for local Agent operations.

## Core Features
* **Multimodal Visual Perception**: Supports real-time image and video stream inputs for accurate screen content comprehension.
* **Streaming Voice Interaction**: Integrates an advanced TTS engine supporting streaming inference, featuring Voice Clone and Voice Design modes.
* **Efficient Local Inference**: Powered by `llama-cpp`, optimized for quantized models to balance VRAM usage and inference speed.
* **Persistence & State Management**: Utilizes SQLAlchemy for structured data and conversation history storage.
* **Modern Desktop Client**: An Electron-based cross-platform client providing a seamless interface for text and multimodal interactions.

## Tech Stack
* **Inference Engine**: llama-cpp
* **Core Models**: Qwen3.5
* **Speech Engine**: Qwen3-TTS
* **Backend Framework**: FastAPI, Python
* **Database/ORM**: SQLAlchemy
* **Frontend**: Electron

## Roadmap
Current development focuses on integrating core Agent paradigms and enhancing personalized interactions:
- [ ] **Retrieval-Augmented Generation (RAG)**: Integration of vector databases for localized knowledge querying.
- [ ] **Skills & Tool Calling**: Enabling the model to execute local scripts, perform web searches, and interact with external APIs.
- [ ] **Persona System**: Implementing a character card system (similar to SillyTavern) to deeply customize AI tone, personality, and long-term memory.

## Deployment & Execution
(Under construction)

---------------

## 项目简介
本项目是一个基于本地部署的大语言模型（LLM）构建的多模态实时交互 AI 助手。系统核心围绕实时视觉识别与语音合成（TTS）构建，能够捕获屏幕内容（视频流或屏幕截图）并提供低延迟的实时语音及文本反馈。

该项目采用前后端分离架构，致力于提供兼具高性能推理与高度可扩展性的本地 Agent 运行环境。

## 核心特性
* **多模态视觉感知**：支持实时图像与视频流输入，具备精准的屏幕内容理解能力。
* **流式语音交互**：集成先进的 TTS 引擎，支持流式推理（Streaming Inference），并提供声音克隆（Voice Clone）与声音设计（Voice Design）模式。
* **高效本地推理**：底层基于 `llama-cpp` 驱动，适配量化模型以优化本地显存占用与推理速度。
* **持久化与状态管理**：采用 SQLAlchemy 进行结构化数据与对话历史的持久化存储。
* **现代化客户端**：基于 Electron 构建的跨平台桌面客户端，提供流畅的文本与多模态交互界面。

## 技术栈
* **推理引擎**: llama-cpp
* **核心模型**: Qwen3.5
* **语音引擎**: Qwen3-TTS
* **后端服务**: FastAPI, Python
* **数据库**: SQLAlchemy
* **前端UI**: Electron

## 路线图 (Roadmap)
当前的开发重点在于引入 Agent 核心范式及增强个性化交互体验：
- [ ] **检索增强生成 (RAG)**：接入向量数据库，实现本地化知识库问答。
- [ ] **技能与工具调用 (Skills/Tools)**：赋予模型执行本地脚本、网络搜索及 API 调用的能力。
- [ ] **人格化交互引擎 (Persona System)**：引入类似 SillyTavern 的角色管理系统，支持深度定制 AI 语气、性格与长期记忆。

## 部署与运行
（待补充）
