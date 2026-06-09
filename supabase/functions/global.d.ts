/**
 * Ambient stubs for editors that run the workspace TypeScript server on Edge Functions.
 * Runtime uses Deno + `npm:@google/genai@…` on Supabase; see `deno.json`.
 */

declare namespace Deno {
  const env: {
    get(key: string): string | undefined;
  };

  function serve(handler: (req: Request) => Response | Promise<Response>): void;
}

declare module "npm:@google/genai@2.8.0" {
  export enum Modality {
    AUDIO = "AUDIO",
  }

  export class GoogleGenAI {
    constructor(opts: { apiKey: string; httpOptions?: { apiVersion?: string } });
    authTokens: {
      create(opts: Record<string, unknown>): Promise<{ name: string; expireTime?: string }>;
    };
  }
}
