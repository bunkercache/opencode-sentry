/**
 * Sentry AI Observability Plugin for OpenCode
 *
 * Sends AI agent telemetry to Sentry for monitoring and analysis:
 *
 * - **Model Usage**: Tracks which models are used, token counts, and costs
 * - **Tool Execution**: Records tool calls with timing and arguments
 * - **Session Lifecycle**: Monitors agent session start, completion, and duration
 * - **Distributed Tracing**: Links spans via TRACEPARENT for end-to-end visibility
 *
 * Data flows to Sentry's AI Monitoring dashboard where you can analyze:
 * - Token usage and costs over time
 * - Model performance comparisons
 * - Tool call patterns and frequency
 * - Session durations and outcomes
 *
 * ## Installation
 *
 * ```bash
 * npm install @bunkercache/opencode-sentry @sentry/bun @opentelemetry/api
 * ```
 *
 * ## Configuration
 *
 * Enable OpenTelemetry in `.opencode/opencode.json`:
 * ```json
 * {
 *   "experimental": {
 *     "openTelemetry": true
 *   }
 * }
 * ```
 *
 * ## Environment Variables
 *
 * - `SENTRY_DSN` - Your Sentry DSN (required)
 * - `TRACEPARENT` - W3C Trace Context for distributed tracing (optional)
 *   Format: `00-<trace-id>-<parent-span-id>-<flags>`
 * - `SENTRY_ENVIRONMENT` - Environment name (default: "development")
 * - `SENTRY_RELEASE` - Release version (default: "opencode@local")
 * - `SENTRY_TRACES_SAMPLE_RATE` - Sample rate 0.0-1.0 (default: "1.0")
 * - `SENTRY_DEBUG` - Set to "true" for verbose logging
 *
 * ## Distributed Tracing
 *
 * Link OpenCode spans to a parent trace for end-to-end visibility:
 *
 * ```bash
 * TRACEPARENT="00-${traceId}-${spanId}-01" \
 * SENTRY_DSN="https://..." \
 * opencode run "Implement the feature"
 * ```
 *
 * @see https://docs.sentry.io/product/insights/ai-monitoring/
 * @see https://www.w3.org/TR/trace-context/
 */

import type { Plugin } from '@opencode-ai/plugin';
import * as Sentry from '@sentry/bun';
import * as otel from '@opentelemetry/api';

export interface SentryPluginOptions {
  /**
   * Sentry DSN. If not provided, will use SENTRY_DSN environment variable.
   */
  dsn?: string;

  /**
   * Environment name. Defaults to SENTRY_ENVIRONMENT or "development".
   */
  environment?: string;

  /**
   * Release version. Defaults to SENTRY_RELEASE or "opencode@local".
   */
  release?: string;

  /**
   * Traces sample rate (0.0 to 1.0). Defaults to SENTRY_TRACES_SAMPLE_RATE or 1.0.
   */
  tracesSampleRate?: number;

  /**
   * Enable debug logging. Defaults to SENTRY_DEBUG === "true".
   */
  debug?: boolean;

  /**
   * Whether to record AI inputs. Defaults to true.
   */
  recordInputs?: boolean;

  /**
   * Whether to record AI outputs. Defaults to true.
   */
  recordOutputs?: boolean;
}

/**
 * Creates a Sentry AI observability plugin for OpenCode.
 *
 * @example
 * ```typescript
 * import { createSentryPlugin } from '@bunkercache/opencode-sentry';
 *
 * export default createSentryPlugin({
 *   dsn: process.env.SENTRY_DSN,
 *   environment: 'production',
 * });
 * ```
 */
export function createSentryPlugin(options: SentryPluginOptions = {}): Plugin {
  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  const environment = options.environment ?? process.env.SENTRY_ENVIRONMENT ?? 'development';
  const release = options.release ?? process.env.SENTRY_RELEASE ?? 'opencode@local';
  const tracesSampleRate =
    options.tracesSampleRate ?? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '1.0');
  const debug = options.debug ?? process.env.SENTRY_DEBUG === 'true';
  const recordInputs = options.recordInputs ?? true;
  const recordOutputs = options.recordOutputs ?? true;

  // Parse W3C Trace Context from TRACEPARENT environment variable
  // Format: version-traceId-parentSpanId-flags (e.g., 00-abc123...-def456...-01)
  const traceparent = process.env.TRACEPARENT;
  let parentTraceId: string | undefined;
  let parentSpanId: string | undefined;
  let sampled = true;

  if (traceparent) {
    const parts = traceparent.split('-');
    if (parts.length === 4) {
      parentTraceId = parts[1];
      parentSpanId = parts[2];
      sampled = parts[3] === '01';
    }
  }

  // Initialize Sentry
  Sentry.init({
    dsn,
    environment,
    release,

    integrations: [
      // Vercel AI SDK integration - auto-instruments AI/LLM calls
      Sentry.vercelAIIntegration({
        recordInputs,
        recordOutputs,
      }),
    ],

    tracesSampleRate,
    sendDefaultPii: true,
    debug,
    enabled: !!dsn,

    initialScope: {
      tags: {
        runtime: 'bun',
        app: 'opencode',
      },
    },
  });

  // Inject TRACEPARENT into OpenTelemetry context for distributed tracing
  // This must happen after Sentry.init() registers the OTel globals
  if (parentTraceId && parentSpanId) {
    const parentContext: otel.SpanContext = {
      traceId: parentTraceId,
      spanId: parentSpanId,
      traceFlags: sampled ? otel.TraceFlags.SAMPLED : otel.TraceFlags.NONE,
      isRemote: true,
    };

    const ctx = otel.trace.setSpanContext(otel.context.active(), parentContext);

    // Patch the context manager to return our parent context when no span is active
    const otelContext = otel.context as unknown as {
      _getContextManager?: () => { active: () => otel.Context; with: unknown } | undefined;
      _contextManager?: { active: () => otel.Context; with: unknown };
    };
    const contextManager = otelContext._getContextManager?.() || otelContext._contextManager;

    if (contextManager?.with) {
      const originalActive = contextManager.active.bind(contextManager);
      const rootContext = ctx;

      contextManager.active = () => {
        const current = originalActive();
        return otel.trace.getSpan(current) ? current : rootContext;
      };
    }
  }

  // Rewrite AI SDK spans to use gen_ai.chat operation for Sentry AI monitoring
  const client = Sentry.getClient();
  if (client) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on('spanStart', (span: any) => {
      const spanName = span.name || '';

      // Only mark doStream/doGenerate spans as gen_ai.chat - these have model/token data
      if (spanName === 'ai.streamText.doStream' || spanName === 'ai.generateText.doGenerate') {
        span.setAttribute('sentry.op', 'gen_ai.chat');

        const attrs = span.attributes || {};
        const model = attrs['ai.model.id'] || attrs['gen_ai.request.model'];
        const provider = attrs['ai.model.provider'] || attrs['gen_ai.system'];

        if (model) span.setAttribute('gen_ai.request.model', model);
        if (provider) span.setAttribute('gen_ai.system', provider);
      }
    });
  }

  return async ({ project, directory, worktree }) => {
    Sentry.setContext('opencode', {
      project: project?.id,
      directory,
      worktree,
    });

    if (project?.id) {
      Sentry.setTag('project', project.id);
    }

    return {
      event: async ({ event }) => {
        switch (event.type) {
          case 'session.created': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sessionId = (event as any).properties?.id;
            Sentry.addBreadcrumb({
              category: 'session',
              message: 'Session created',
              level: 'info',
              data: { sessionId },
            });
            break;
          }

          case 'session.error': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const error = (event as any).properties?.error;
            if (error) {
              Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
                tags: { source: 'session.error' },
              });
            }
            break;
          }

          case 'session.idle':
            Sentry.addBreadcrumb({
              category: 'session',
              message: 'Session completed',
              level: 'info',
            });
            await Sentry.flush(2000);
            break;
        }
      },

      'tool.execute.before': async (input, output) => {
        Sentry.addBreadcrumb({
          category: 'tool',
          message: `Tool: ${input.tool}`,
          level: 'info',
          data: {
            tool: input.tool,
            argKeys: Object.keys(output.args || {}),
          },
        });
      },

      'tool.execute.after': async (input, output) => {
        // Check metadata for errors
        const error = output.metadata?.error;
        if (error) {
          Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
            tags: {
              source: 'tool.execute',
              tool: input.tool,
            },
          });
        }
      },
    };
  };
}

/**
 * Default Sentry plugin instance using environment variables for configuration.
 *
 * @example
 * ```typescript
 * // In .opencode/plugins/sentry.ts
 * export { SentryPlugin } from '@bunkercache/opencode-sentry';
 * ```
 */
export const SentryPlugin = createSentryPlugin();

export default SentryPlugin;
