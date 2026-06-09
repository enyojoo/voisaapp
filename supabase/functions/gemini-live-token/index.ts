import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { GoogleGenAI, Modality } from "npm:@google/genai@2.8.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = "gemini-3.5-live-translate-preview";

type Body = {
  languageA?: string;
  languageB?: string;
};

function normalizeLang(code: string | undefined, fallback: string): string {
  const raw = (code ?? fallback).trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (lower === "zh") return "zh-Hans";
  if (lower === "pt") return "pt-BR";
  if (lower === "tl") return "fil";
  if (lower === "iw") return "he";
  return raw;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiApiKey) {
    return new Response(JSON.stringify({ error: "Missing GEMINI_API_KEY" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const languageA = normalizeLang(body.languageA, "en");
  const languageB = normalizeLang(body.languageB, "es");

  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  try {
    const client = new GoogleGenAI({
      apiKey: geminiApiKey,
      httpOptions: { apiVersion: "v1alpha" },
    });

    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            translationConfig: {
              targetLanguageCode: languageB,
              echoTargetLanguage: true,
            },
          },
        },
        httpOptions: { apiVersion: "v1alpha" },
      },
    });

    const ephemeral = token.name;
    if (!ephemeral) {
      return new Response(JSON.stringify({ error: "Gemini auth token missing name" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        token: ephemeral,
        model: MODEL,
        expireTime,
        languageA,
        languageB,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: "Failed to create Gemini ephemeral token", detail }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
