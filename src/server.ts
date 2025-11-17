#!/usr/bin/env node
// src/server.ts
import * as dotenv from 'dotenv';
dotenv.config(); // Load environment variables from .env first

import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { allTools, toolHandlers } from './tools/index.js';
import { z } from 'zod';


function createMcpServer() {
    const server = new McpServer({
        name: 'wordpress',
        version: '0.0.1'
    }, {
        capabilities: {
            tools: allTools.reduce((acc, tool) => {
                acc[tool.name] = tool;
                return acc;
            }, {} as Record<string, unknown>)
        }
    });

    for (const tool of allTools) {
        const handler = toolHandlers[tool.name as keyof typeof toolHandlers];
        if (!handler) {
            continue;
        }

        const wrappedHandler = async (args: any) => {
            const result = await handler(args);
            return {
                content: result.toolResult.content.map((item: { type: string; text: string }) => ({
                    ...item,
                    type: 'text' as const
                })),
                isError: result.toolResult.isError
            };
        };

        const zodSchema = z.object(tool.inputSchema.properties as z.ZodRawShape);
        server.tool(tool.name, zodSchema.shape, wrappedHandler);
    }

    return server;
}

type SessionEntry = {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
};

function getSessionId(value: string | string[] | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    return Array.isArray(value) ? value[0] : value;
}

async function startStdioServer(logToFile: (message: string) => void) {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logToFile('WordPress MCP server running on stdio');

    return async () => {
        try {
            await transport.close();
        } catch (error) {
            logToFile(`Error closing stdio transport: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
            await server.close();
        } catch (error) {
            logToFile(`Error closing MCP server: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
}

async function startHttpServer(logToFile: (message: string) => void) {
    const port = Number(process.env.PORT ?? process.env.MCP_PORT ?? 8080);
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use(cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id']
    }));

    const requiredToken = process.env.MCP_API_TOKEN;
    if (requiredToken) {
        app.use((req: Request, res: Response, next) => {
            const authHeader = req.headers.authorization;
            if (authHeader === `Bearer ${requiredToken}`) {
                next();
                return;
            }
            res.status(401).json({
                jsonrpc: '2.0',
                error: {
                    code: -32001,
                    message: 'Unauthorized'
                },
                id: null
            });
        });
    } else {
        logToFile('Warning: MCP_API_TOKEN is not set; HTTP transport is running without authentication.');
    }

    const sessions = new Map<string, SessionEntry>();

    const createSession = () => {
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: sessionId => {
                if (sessionId) {
                    sessions.set(sessionId, { server, transport });
                    logToFile(`Initialized MCP session ${sessionId}`);
                }
            },
            onsessionclosed: sessionId => {
                if (sessionId) {
                    sessions.delete(sessionId);
                    logToFile(`Closed MCP session ${sessionId}`);
                }
            }
        });

        transport.onclose = async () => {
            const sessionId = transport.sessionId;
            if (sessionId) {
                sessions.delete(sessionId);
            }
            try {
                await server.close();
            } catch (error) {
                logToFile(`Error closing MCP server for session ${sessionId ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`);
            }
        };

        return { server, transport };
    };

    const ensureSession = (sessionId: string) => {
        const session = sessions.get(sessionId);
        if (!session) {
            return null;
        }
        return session;
    };

    app.get('/healthz', (_req: Request, res: Response) => {
        res.status(200).send('ok');
    });

    app.get('/', (_req: Request, res: Response) => {
        res.status(200).send('ok');
    });

    app.post('/mcp', async (req: Request, res: Response) => {
        const sessionId = getSessionId(req.headers['mcp-session-id']);

        try {
            if (sessionId) {
                const session = ensureSession(sessionId);
                if (!session) {
                    res.status(404).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32000,
                            message: 'Unknown session ID'
                        },
                        id: null
                    });
                    return;
                }

                await session.transport.handleRequest(req, res, req.body);
                return;
            }

            if (!isInitializeRequest(req.body)) {
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32600,
                        message: 'Initialization request required before other operations'
                    },
                    id: null
                });
                return;
            }

            const session = createSession();
            await session.server.connect(session.transport);
            await session.transport.handleRequest(req, res, req.body);
        } catch (error) {
            logToFile(`Error handling MCP POST request: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: 'Internal server error'
                    },
                    id: null
                });
            }
        }
    });

    app.get('/mcp', async (req: Request, res: Response) => {
        const sessionId = getSessionId(req.headers['mcp-session-id']);
        if (!sessionId) {
            res.status(400).send('Missing session ID');
            return;
        }

        const session = ensureSession(sessionId);
        if (!session) {
            res.status(404).send('Unknown session ID');
            return;
        }

        try {
            await session.transport.handleRequest(req, res);
        } catch (error) {
            logToFile(`Error handling MCP GET request for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) {
                res.status(500).send('Internal server error');
            }
        }
    });

    app.delete('/mcp', async (req: Request, res: Response) => {
        const sessionId = getSessionId(req.headers['mcp-session-id']);
        if (!sessionId) {
            res.status(400).send('Missing session ID');
            return;
        }

        const session = ensureSession(sessionId);
        if (!session) {
            res.status(404).send('Unknown session ID');
            return;
        }

        try {
            await session.transport.handleRequest(req, res);
        } catch (error) {
            logToFile(`Error handling MCP DELETE request for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) {
                res.status(500).send('Internal server error');
            }
        }
    });

    const httpServer: HttpServer = await new Promise((resolve, reject) => {
        const serverInstance = app.listen(port, '0.0.0.0', () => {
            logToFile(`WordPress MCP HTTP server listening on port ${port}`);
            resolve(serverInstance);
        });
        serverInstance.once('error', reject);
    });

    return async () => {
        logToFile('Shutting down HTTP server...');

        for (const [sessionId, session] of sessions) {
            try {
                await session.transport.close();
            } catch (error) {
                logToFile(`Error closing transport for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            }

            try {
                await session.server.close();
            } catch (error) {
                logToFile(`Error closing MCP server for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            }

            sessions.delete(sessionId);
        }

        await new Promise<void>((resolve, reject) => {
            httpServer.close(error => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    };
}

function setupProcessHandlers(cleanup: () => Promise<void>) {
    let shuttingDown = false;

    const shutdown = async (exitCode: number) => {
        if (shuttingDown) {
            process.exit(exitCode);
        }
        shuttingDown = true;

        try {
            await cleanup();
        } catch (error) {
            console.error('Error during shutdown cleanup:', error);
        } finally {
            process.exit(exitCode);
        }
    };

    process.on('SIGTERM', () => {
        console.log('Received SIGTERM signal, shutting down...');
        void shutdown(0);
    });

    process.on('SIGINT', () => {
        console.log('Received SIGINT signal, shutting down...');
        void shutdown(0);
    });

    process.on('uncaughtException', error => {
        console.error('Uncaught exception:', error);
        void shutdown(1);
    });

    process.on('unhandledRejection', error => {
        console.error('Unhandled rejection:', error);
        void shutdown(1);
    });
}

async function main() {
    const { logToFile, initWordPress } = await import('./wordpress.js');
    logToFile('Starting WordPress MCP server...');

    if (!process.env.WORDPRESS_API_URL) {
        logToFile('Missing required environment variables. Please check your .env file.');
        process.exit(1);
    }

    try {
        logToFile('Initializing WordPress client...');
        await initWordPress();
        logToFile('WordPress client initialized successfully.');

        let cleanup: () => Promise<void>;

        if (process.env.PORT) {
            logToFile(`Detected PORT environment variable (${process.env.PORT}); starting HTTP transport.`);
            cleanup = await startHttpServer(logToFile);
        } else {
            logToFile('No PORT environment variable detected; starting stdio transport.');
            cleanup = await startStdioServer(logToFile);
        }

        setupProcessHandlers(cleanup);
    } catch (error) {
        logToFile(`Failed to initialize server: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

void main().catch(error => {
    console.error('Startup error:', error);
    process.exit(1);
});