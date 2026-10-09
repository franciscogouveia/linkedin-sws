import OpenAI from 'openai';
import type { Config } from '../../app/config.ts';
import { ApplicationError } from '../../shared/errors.ts';
import type { TextGenerator, TextRequest } from '../../shared/types.ts';
import { describeLlmError } from './errors.ts';

export class OpenAITextClient implements TextGenerator {
  private readonly client: OpenAI;
  private readonly settings: Config['llm'];
  private readonly signal: AbortSignal;

  constructor(settings: Config['llm'], signal: AbortSignal) {
    this.settings = settings;
    this.signal = signal;
    this.client = new OpenAI({
      apiKey: settings.api_key,
      baseURL: settings.base_url,
      timeout: settings.timeout_ms,
      maxRetries: 0,
    });
  }

  async request(request: TextRequest): Promise<string> {
    const { instructions, input, format } = request;
    this.signal.throwIfAborted();
    try {
      let text: string;
      if (this.settings.api === 'responses') {
        const response = await this.client.responses.create(
          {
            model: this.settings.model,
            instructions,
            input,
            store: false,
            max_output_tokens: this.settings.max_output_tokens,
            ...(format && this.settings.structured_output
              ? {
                  text: {
                    format: {
                      type: 'json_schema',
                      name: format.name,
                      strict: true,
                      schema: format.schema,
                    },
                  },
                }
              : {}),
          },
          { signal: this.signal },
        );
        if (response.status !== 'completed') {
          throw new ApplicationError(
            'The LLM response was incomplete. Check the model and output token budget.',
          );
        }
        text = response.output_text;
      } else {
        const response = await this.client.chat.completions.create(
          {
            model: this.settings.model,
            store: false,
            messages: [
              { role: 'system', content: instructions },
              { role: 'user', content: input },
            ],
            max_completion_tokens: this.settings.max_output_tokens,
            ...(format && this.settings.structured_output
              ? {
                  response_format: {
                    type: 'json_schema',
                    json_schema: {
                      name: format.name,
                      strict: true,
                      schema: format.schema,
                    },
                  },
                }
              : {}),
          },
          { signal: this.signal },
        );
        const choice = response.choices[0];
        if (choice?.finish_reason !== 'stop' || choice.message.refusal) {
          throw new ApplicationError(
            'The LLM did not complete the requested text. Check the model and output token budget.',
          );
        }
        text = choice.message.content ?? '';
      }
      if (!text.trim())
        throw new ApplicationError('The LLM returned no usable text.');
      return text.trim();
    } catch (error) {
      if (this.signal.aborted) throw this.signal.reason;
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        describeLlmError(error, this.settings, request.operation, [
          input,
          instructions,
          ...request.redactions,
        ]),
      );
    }
  }
}
