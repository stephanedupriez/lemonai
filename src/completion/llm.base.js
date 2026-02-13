const TYPE_ENUM = {
  SSE: 'SSE',
  STREAM: 'STREAM'
}

// When truncating prompt logs, show a readable preview (including visible "\n").
// Example: "\ntest1\ntest2" instead of showing just "..." when the first line is empty.
const PROMPT_LOG_PREVIEW_CHARS = 100;

// Enable to log minimal diagnostics when an SSE call returns an empty final content.
// Keep false by default to avoid noisy logs.
const DEBUG_EMPTY_SSE = false;

// When true, non-last messages in [PROMPT LLM] logs are truncated to a one-line preview.
// Set to false to log full content for every message.
const TRUNCATE_OLD_MESSAGES_IN_PROMPT_LOG = true;

const axios = require('axios');

class LLM {

  constructor(onTokenStream = (chunk) => { }, model = '', options = {}) {
    this.onTokenStream = onTokenStream;
    // 设置默认接口处理逻辑
    this.responseType = TYPE_ENUM.SSE;
    this.splitter = '\n\n'
    if (model) { this.model = model }
    this.options = options;
  }

  /**
   * 提问大模型 && 记录日志
   * 依赖 start 实现提问逻辑
   * @param {*} prompt 
   * @param {*} context 
   * @param {*} options 
   * @returns 
   */
  async completion(prompt, context = {}, options = {}) {
    // 发起调用
    const content = await this.start(prompt, context, options);
    return content;
  }

  /**
   * 发起请求并对返回流式数据进行处理
   * 若非 SSE 标准处理逻辑, 覆盖 start 的实现
   * @param {*} prompt 
   */
  async start(prompt, context = {}, options = {}) {
    // 发起调用
    const response = await this.call(prompt, context, options);
    // 处理SSE
    if (this.responseType === TYPE_ENUM.SSE) {
      const content = await this.handleSSE(response)
      return content;
    }
    return ""
  }

  async message(messages = [], options = {}) {
    const response = await this.request(messages, options);
    // 处理SSE
    if (this.responseType === TYPE_ENUM.SSE) {
      const content = await this.handleSSE(response)
      return content;
    }
    return ""
  }

  resolveConfigHeaders = (config) => {
    if (this.API_KEY) {
      Object.assign(config.headers, {
        "Authorization": `Bearer ${this.API_KEY}`,
      });
      if (config.url && config.url.indexOf('azure') !== -1) {
        Object.assign(config.headers, {
          "api-key": this.API_KEY
        });
      }
      if (config.url && config.url.indexOf('baidu') !== -1) {
        Object.assign(config.headers, { "appid": this.appid });
      }
    }
  }

  async request(messages = [], options = {}) {
    const model = options.model || this.model;

    const body = {
      model,
      messages,
      stream: true,
    }

    /**
     * Supported options
     * - temperature: Controls the randomness of generated text. Higher values increase randomness, lower values decrease it
     * - top_p: Sampling probability threshold, controls the diversity of generated text. Higher values increase diversity
     * - max_tokens: Maximum length limit for generated text
     * - stop: Stop sequence markers for generation
     * - stream: Whether to enable streaming response
     * - assistant_id: Assistant ID, used to identify specific assistants in multi-turn conversations
     * - response_format: Response format, such as JSON
     * - tools: List of callable tool functions, used for advanced features like function calling
     * - enable_thinking: Whether to enable thinking mode, applicable to Qwen3 model
     */
    const supportOptions = ['temperature', 'top_p', 'max_tokens', 'stop', 'stream', 'assistant_id', 'response_format', 'tools', 'enable_thinking'];
    for (const key in options) {
      if (supportOptions.includes(key) && options[key] !== undefined) {
        body[key] = options[key];
        console.log('body.options', key, options[key]);
      }
    }
    // console.log('body', body);
    const config = {
      url: this.CHAT_COMPLETION_URL,
      method: "post",
      maxBodyLength: Infinity,
      headers: {
        "Content-Type": 'application/json'
      },
      data: body,
      responseType: "stream"
    };

    if (options.signal) {
      config.signal = options.signal;
    }

    if (config.url && config.url.indexOf('openrouter.ai') !== -1) {
      Object.assign(config.headers, {
        "HTTP-Referer": 'https://lemonai.cc',
        "X-Title": "LemonAI"
      })
    }
    // console.log('config', config);
    this.resolveConfigHeaders(config);
    // console.log('config', JSON.stringify(config, null, 2));
    const response = await axios.request(config).catch(err => {
      return err;
    });
    // console.log('response', response);
    return response;
  }

  // 发起 HTTP 请求
  async call(prompt = '', context = {}, options = {}) {
    const messages = context.messages || [];
    // Best-effort task id extraction for logging correlation.
    // The LLM never sees these tags; this is purely for operator logs.
    const resolveTaskIdForLog = () => {
      try {
        // Common shapes: context.task_id, context.taskId, context.task.id, options.task_id, options.taskId
        const ctx = context || {};
        const opt = options || {};
        const candidates = [
          ctx.task_id,
          ctx.taskId,
          ctx.task && ctx.task.id,
          ctx.current_task_id,
          ctx.currentTaskId,
          opt.task_id,
          opt.taskId,
          opt.current_task_id,
          opt.currentTaskId,
        ];
        for (const c of candidates) {
          if (c === undefined || c === null) continue;
          const s = String(c).trim();
          if (s) return s;
        }
      } catch (e) {
        // ignore
      }
      return 'unknown';
    };
    const taskIdForLog = resolveTaskIdForLog();
    if (prompt) {
      const massageUser = { "role": "user", "content": prompt };
      messages.push(massageUser);
    }

    // Single source of truth: log the exact messages array that will be sent to the LLM.
    // Format:
    // [PROMPT LLM]
    // [MESSAGE0] ... [/MESSAGE0]
    // ...
    // [/PROMPT LLM]
    try {
      process.stdout.write(`\n[PROMPT LLM]\n`);
      for (let i = 0; i < messages.length; i++) {

        const role = (messages[i] && messages[i].role !== undefined && messages[i].role !== null)
          ? String(messages[i].role)
          : 'unknown';
		  
        const pruneHash =
          messages[i] &&
          messages[i].meta &&
          typeof messages[i].meta.prune_hash === 'string'
            ? messages[i].meta.prune_hash
            : '';


        const content = (messages[i] && messages[i].content !== undefined && messages[i].content !== null)
          ? String(messages[i].content)
          : '';

        const isLast = (i === messages.length - 1);

        if (!isLast) {
          if (TRUNCATE_OLD_MESSAGES_IN_PROMPT_LOG) {
            // Preview behavior:
            // - keep a single-line log entry
            // - make newlines visible as "\n"
            // - show the first N characters (including the leading "\n" if present)
            const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            const escaped = normalized.replace(/\n/g, "\\n");
            const preview = escaped.length > PROMPT_LOG_PREVIEW_CHARS
              ? escaped.slice(0, PROMPT_LOG_PREVIEW_CHARS)
              : escaped;
            process.stdout.write(
              `[MESSAGE${i} task=${taskIdForLog} role=${role}${pruneHash ? ` pruneHash="${pruneHash}"` : ''}]` +
              `${preview}[/MESSAGE${i}]\n`
            );
            continue;
          }

          process.stdout.write(
            `[MESSAGE${i} task=${taskIdForLog} role=${role}${pruneHash ? ` pruneHash="${pruneHash}"` : ''}]\n`
          );
          process.stdout.write(`${content}\n`);
          process.stdout.write(`[/MESSAGE${i}]\n`);
          continue;
        }

        process.stdout.write(
          `[MESSAGE${i} task=${taskIdForLog} role=${role}${pruneHash ? ` pruneHash="${pruneHash}"` : ''}]\n`
        );
        process.stdout.write(`${content}\n`);
        process.stdout.write(`[/MESSAGE${i}]\n`);
      }
      process.stdout.write(`[/PROMPT LLM]\n`);
    } catch (e) {
      // Never block LLM calls due to logging failures
    }

    // console.log("发起请求.messages", messages);
    return this.request(messages, options);
  }

  resolveRequestMessages(input, context) {

  }

  // 处理流式请求
  async handleSSE(response) {
    if (response.code) {
      const content = response.code;
      this.onTokenStream(`${response.code}:${response.status}`);
      return content;
    }

    // 处理流式返回
    let fullContent = "";
    let reasoning = false;
    const fn = new Promise((resolve, reject) => {
      let content = "";
      let bytesReceived = 0;
      let chunksReceived = 0;
      let lastRemainder = "";
	  
      const applyValueToContent = (value) => {
        if (!value || (value.type !== "text" && value.type !== "reasoning")) return;
        let ch = value.text;
        // 处理 reasoning
        if (value.type === 'reasoning' && fullContent === '') {
          ch = '<think>' + ch;
          reasoning = true;
        }
        if (value.type === 'text' && reasoning) {
          ch = '</think>' + ch;
          reasoning = false;
        }
        if (ch) {
          fullContent += ch;
          this.onTokenStream(ch);
        }
      };

      const consumeSSEMessage = (message) => {
        const value = this.messageToValue(message);
        applyValueToContent(value);
      };
	  
      const tryBestEffortExtractTextFromJsonish = (text) => {
        // Best-effort extraction for cases where the server doesn't strictly prefix with "data:"
        // or closes the stream with partial chunks.
        if (!text) return "";
        const s = String(text);
        // Try to find `"content":"..."` or `"reasoning_content":"..."`
        // This is intentionally conservative: we only unescape the most common sequences.
        const m =
          s.match(/"reasoning_content"\s*:\s*"((?:\\.|[^"\\])*)"/) ||
          s.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (!m) return "";
        let out = m[1] || "";
        out = out
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, "\"")
          .replace(/\\\\/g, "\\");
        return out;
      };

      // Flush any remaining buffer that doesn't end with splitter.
      // Some SSE servers close the connection without trailing "\n\n",
      // which previously resulted in fullContent staying empty.
      const flushRemainder = () => {
        const splitter = this.splitter;
        // First, consume any complete messages that might still be present.
        while (content.indexOf(splitter) !== -1) {
          const index = content.indexOf(splitter);
          const message = content.slice(0, index);
          content = content.slice(index + splitter.length);
          consumeSSEMessage(message);
        }

        const rem = (content || '').trim();
		lastRemainder = rem;
        if (!rem) return;

        // Typical SSE remainder looks like one or more lines starting with "data:".
        // Handle multiple "data:" lines defensively.
        const lines = rem.split(/\r?\n/).filter(l => l.trim().startsWith('data:'));
        if (lines.length > 0) {
          for (const line of lines) {
            consumeSSEMessage(line.trim());
          }
        } else {
          // Fallback: try parsing the whole remainder as one SSE message
          consumeSSEMessage(rem);
          // If it still produced nothing, try best-effort extraction from JSON-ish text.
          if (!fullContent) {
            const extracted = tryBestEffortExtractTextFromJsonish(rem);
            if (extracted) {
              applyValueToContent({ type: "text", text: extracted });
            }
          }
        }

        content = "";
      };

      response.data.on("data", (chunk) => {
        chunksReceived += 1;
        bytesReceived += Buffer.byteLength(chunk || "");
        content += chunk;
        const splitter = this.splitter;
        while (content.indexOf(splitter) !== -1) {
          const index = content.indexOf(splitter);
          const message = content.slice(0, index);
          content = content.slice(index + splitter.length);
          consumeSSEMessage(message);
        }
      });
      response.data.on("end", () => {
		flushRemainder();
        if (DEBUG_EMPTY_SSE && (!fullContent || !fullContent.trim())) {
          const status = response && typeof response.status !== 'undefined' ? response.status : 'unknown';
          const url = response && response.config && response.config.url ? response.config.url : 'unknown';
          console.log(
            `[SSE_EMPTY] status=${status} chunks=${chunksReceived} bytes=${bytesReceived} ` +
            `url=${url} remainder_len=${(lastRemainder || '').length}`
          );
        }
        resolve(fullContent);
      });
      response.data.on("error", (err) => {
        if (err.code === 'ERR_CANCELED' || err.message === 'canceled') {
          console.log('请求被中断');
		  flushRemainder();
          if (DEBUG_EMPTY_SSE && (!fullContent || !fullContent.trim())) {
            const status = response && typeof response.status !== 'undefined' ? response.status : 'unknown';
            const url = response && response.config && response.config.url ? response.config.url : 'unknown';
            console.log(
              `[SSE_EMPTY_CANCEL] status=${status} chunks=${chunksReceived} bytes=${bytesReceived} ` +
              `url=${url} remainder_len=${(lastRemainder || '').length}`
            );
          }
          resolve(fullContent);
        } else {
          reject(err)
        }

      });

    });

    const content = await fn;
    return content;
  }

  /**
   * 标准 chat/completions message 处理解析逻辑
   * 1. 截取 data: 后并 JSON.parse
   * 2. 读取 json.choices[0].delta.content
   * 
   * 适用服务 openai | minimax | kimi | deepseek | zhipu(智谱) | qwen 开源
   * @param {*} message 
   * @returns { type: 'text', text: '' }
   */
  messageToValue(message) {
    // console.log('message', message);
    if (message == "data: [DONE]" || message.startsWith("data: [DONE]")) {
      return { type: "done" };
    }
    // Accept both strict SSE lines ("data: {...}") and non-standard payloads.
    let data = "";
    if (typeof message === 'string' && message.includes("data:")) {
      data = message.split("data:")[1];
    } else {
      data = message;
    }
    let value = {}
    try {
      value = JSON.parse(data)
    } catch (error) {
      // Do NOT treat parse failures as "done": some servers send partial / non-standard chunks.
      // Returning "unknown" prevents prematurely discarding potential remainder content.
      return { type: "unknown", text: "" };
    }

    // token 消耗消息
    if (value.usage) {
      // console.log('\nToken.Usage', value.usage);
      // return { type: "done" };
    }

    const choices = value.choices || [];
    const choice = choices[0] || {};
    if (Object.keys(choice).length === 0) {
      return { type: "text", text: "" }
    }
    // 工具使用处理
    if (choice.delta && choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
      this.tools = choice.delta.tool_calls;
    }

    // reasoning thinking
    if (choice.delta && choice.delta.reasoning_content) {
      return { type: "reasoning", text: choice.delta.reasoning_content };
    }

    if (choice.delta && choice.delta.content) {
      return { type: "text", text: choice.delta.content };
    }
    return {};
  }
}

module.exports = exports = LLM;