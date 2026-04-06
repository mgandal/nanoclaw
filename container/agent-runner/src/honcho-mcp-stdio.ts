/**
 * Honcho MCP Server for NanoClaw
 * Exposes Honcho user-context tools for the container agent.
 * Reads user history, profile, and synthesizes answers via dialectic reasoning.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createHonchoClient } from './honcho-client.js';

const HONCHO_URL = process.env.HONCHO_URL || '';
const HONCHO_WORKSPACE = process.env.HONCHO_WORKSPACE || 'nanoclaw';
const HONCHO_USER_PEER = process.env.HONCHO_USER_PEER || 'mgandal';
const HONCHO_AI_PEER = process.env.HONCHO_AI_PEER || 'nanoclaw-agent';

function log(msg: string): void {
  console.error(`[HONCHO] ${msg}`);
}

const client = createHonchoClient(HONCHO_URL);

const server = new McpServer({
  name: 'honcho',
  version: '1.0.0',
});

server.tool(
  'honcho_profile',
  'Get the user\'s profile card from Honcho — a synthesized summary of who the user is, their preferences, and behavioral patterns. Fast, no LLM involved. Use this at the start of a conversation to understand the user\'s context.',
  {},
  async () => {
    log('Getting user profile card...');
    try {
      const card = await client.getPeerCard(HONCHO_WORKSPACE, HONCHO_USER_PEER);
      if (!card) {
        return { content: [{ type: 'text' as const, text: 'No profile card available yet.' }] };
      }
      log(`Got profile card (${card.length} chars)`);
      return { content: [{ type: 'text' as const, text: card }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get profile: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'honcho_search',
  'Semantic search over the user\'s message history stored in Honcho. Returns relevant past messages matching the query. Use this to find what the user has said about a topic in previous conversations.',
  {
    query: z.string().describe('What to search for in the user\'s message history'),
  },
  async (args) => {
    log(`Searching: "${args.query.slice(0, 80)}..."`);
    try {
      const results = await client.peerSearch(
        HONCHO_WORKSPACE,
        HONCHO_AI_PEER,
        args.query,
        HONCHO_USER_PEER,
      );
      if (!results || results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching messages found.' }] };
      }
      const formatted = results
        .map(r => `[${r.created_at}] ${r.content.slice(0, 500)}`)
        .join('\n\n');
      log(`Found ${results.length} results`);
      return { content: [{ type: 'text' as const, text: formatted }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'honcho_context',
  'Ask Honcho a question about the user using dialectic LLM reasoning over the user\'s history. Slow (30-60s) but produces a synthesized answer rather than raw search results. Use this when you need an interpretive answer about the user\'s preferences, patterns, or background.',
  {
    query: z.string().describe('The question to answer about the user based on their history'),
  },
  async (args) => {
    log(`Dialectic query: "${args.query.slice(0, 80)}..."`);
    try {
      const answer = await client.peerChat(HONCHO_WORKSPACE, HONCHO_AI_PEER, args.query);
      if (!answer) {
        return { content: [{ type: 'text' as const, text: 'Honcho could not generate a response.' }] };
      }
      log(`Got answer (${answer.length} chars)`);
      return { content: [{ type: 'text' as const, text: answer }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Context query failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'honcho_conclude',
  'Save a conclusion about the user to Honcho\'s long-term memory. Use this to record important insights, preferences, or facts learned about the user during the conversation.',
  {
    content: z.string().describe('The conclusion or insight about the user to save'),
  },
  async (args) => {
    log(`Saving conclusion: "${args.content.slice(0, 80)}..."`);
    try {
      const ok = await client.addConclusions(HONCHO_WORKSPACE, [
        {
          content: args.content,
          observer_id: HONCHO_AI_PEER,
          observed_id: HONCHO_USER_PEER,
        },
      ]);
      if (!ok) {
        return { content: [{ type: 'text' as const, text: 'Failed to save conclusion.' }] };
      }
      log('Conclusion saved');
      return { content: [{ type: 'text' as const, text: 'Conclusion saved.' }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to save conclusion: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
