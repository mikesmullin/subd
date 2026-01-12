export const toolsDefinition = [
  // Agent Tools
  {
    type: "function",
    function: {
      name: "agent__templates__list",
      description: "List available agent templates",
      parameters: { type: "object", properties: {} }
    },
    metadata: {
      help: "agent templates list",
      alias: (args) => {
        // Matches: agent, agents, agent list, agents list (with optional --all)
        const input = args.join(' ');
        if (/^agents?(?:\s+list)?(?:\s+--all)?$/.test(input)) {
          return { 
            name: 'agent__templates__list',
            args: { all: input.includes('--all') } 
          };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__new",
      description: "Create new agent session",
      parameters: {
        type: "object",
        properties: {
          template: { type: "string", description: "Template name" },
          prompt: { type: "string", description: "Initial prompt" }
        },
        required: ["template"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "agent @<template> [prompt]",
      alias: (args) => {
        // Matches: agent @<template> [prompt...]
        // args = ["agent", "@ada", "tell", "me", "a", "joke"]
        if (args.length < 2) return false;
        if (args[0] !== 'agent') return false;
        
        const templateArg = args[1];
        if (!templateArg.startsWith('@')) return false;
        
        const template = templateArg.substring(1);
        const prompt = args.slice(2).join(' ') || undefined;
        
        return { name: 'agent__session__new', args: { template, prompt } };
      }
    }
  },
  // Session Tools
  {
    type: "function",
    function: {
      name: "agent__sessions__list",
      description: "List active sessions",
      parameters: { type: "object", properties: {} }
    },
    metadata: {
      requiresHostExecution: true,
      help: "sessions",
      alias: (args) => {
        // Matches: /(:?agent )?(sessions?)/
        const input = args.join(' ');
        if (/^(:?agent )?(sessions?)$/.test(input)) {
          return { name: 'agent__sessions__list', args: {} };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__detail",
      description: "Show session details",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "detail <id>",
      alias: (args) => {
        const match = args.join(' ').match(/^(?:sessions?\s+)?detail\s+(\S+)$/);
        if (match) {
          return { name: 'agent__session__detail', args: { id: match[1] } };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__chat",
      description: "Send message to session",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          msg: { type: "string" }
        },
        required: ["id", "msg"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "chat <id> <msg>",
      alias: (args) => {
        // Matches: chat <id> <msg...>
        if (args.length >= 3 && args[0] === 'chat') {
          const id = args[1];
          const msg = args.slice(2).join(' ');
          return { name: 'agent__session__chat', args: { id, msg } };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__last",
      description: "Show last message",
      parameters: {
        type: "object",
        properties: { 
          id: { type: "string" },
          maxlen: { type: "number", description: "Maximum length of the response (default: 2048)" }
        },
        required: ["id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "last <id>",
      alias: (args) => {
        const input = args.join(' ');
        if (/^(?:agent|agents)?\s*(?:session|sessions)\s+last\s+\S+$/.test(input) || 
            /^last\s+\S+$/.test(input)) {
          // Extract the ID from the end
          const parts = args.filter(a => a !== 'agent' && a !== 'agents' && a !== 'session' && a !== 'sessions' && a !== 'last');
          return { name: 'agent__session__last', args: { id: parts[0] } };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__status",
      description: "Show session status",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "session status <id>",
      alias: (args) => {
        if (args[0] === 'session' && args[1] === 'status') {
          return { name: 'agent__session__status', args: { id: args[2] } };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__log",
      description: "Show container logs",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "log <id>",
      alias: (args) => {
        const input = args.join(' ');
        if (/^(?:agent|agents)?\s*(?:session|sessions)\s+logs?\s+\S+$/.test(input) ||
            /^log\s+\S+$/.test(input)) {
          // Extract the ID from the end
          const parts = args.filter(a => a !== 'agent' && a !== 'agents' && a !== 'session' && a !== 'sessions' && a !== 'log'&& a !== 'logs');
          return { name: 'agent__session__log', args: { id: parts[0] } };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__ps",
      description: "Show container processes",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "session ps <id>",
      alias: (args) => {
        if (args[0] === 'session' && args[1] === 'ps') {
          return { name: 'agent__session__ps', args: { id: args[2] } };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__pause",
      description: "Pause session",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "session pause <id>",
      alias: (args) => {
        if (args[0] === 'session' && args[1] === 'pause') {
          return { name: 'agent__session__pause', args: { id: args[2] } };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__resume",
      description: "Resume session",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "session resume <id>",
      alias: (args) => {
        if (args[0] === 'session' && args[1] === 'resume') {
          return { name: 'agent__session__resume', args: { id: args[2] } };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__stop",
      description: "Stop session",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "session stop <id>",
      alias: (args) => {
        if (args[0] === 'session' && args[1] === 'stop') {
          return { name: 'agent__session__stop', args: { id: args[2] } };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__run",
      description: "Run/Restart session",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "session run <id>",
      alias: (args) => {
        if (args[0] === 'session' && args[1] === 'run') {
          return { name: 'agent__session__run', args: { id: args[2] } };
        }
        return false;
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agent__session__delete",
      description: "Delete session",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "session delete <id>",
      alias: (args) => {
        if (args[0] === 'session' && (args[1] === 'delete' || args[1] === 'rm')) {
          return { name: 'agent__session__delete', args: { id: args[2] } };
        }
        return false;
      }
    }
  },
  // Group Tools
  {
    type: "function",
    function: {
      name: "agent__groups__list",
      description: "List all groups",
      parameters: { type: "object", properties: {} }
    },
    metadata: {
      requiresHostExecution: true,
      help: "agent groups list"
    }
  },
  {
    type: "function",
    function: {
      name: "agent__group__new",
      description: "Create new group",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "agent group new <name>"
    }
  },
  {
    type: "function",
    function: {
      name: "agent__group__add",
      description: "Add session to group",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          id: { type: "string" }
        },
        required: ["name", "id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "agent group add <name> <id>"
    }
  },
  {
    type: "function",
    function: {
      name: "agent__group__remove",
      description: "Remove session from group",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          id: { type: "string" }
        },
        required: ["name", "id"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "agent group remove <name> <id>"
    }
  },
  {
    type: "function",
    function: {
      name: "agent__group__delete",
      description: "Delete group",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "agent group delete <name>"
    }
  },
  {
    type: "function",
    function: {
      name: "agent__group__detail",
      description: "Show group details",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    },
    metadata: {
      requiresHostExecution: true,
      help: "agent group detail <name>"
    }
  },
  // Agent Utility Tools
  {
    type: "function",
    function: {
      name: "agent__sleep",
      description: "Sleep for a specified duration",
      parameters: {
        type: "object",
        properties: { ms: { type: "number" } },
        required: ["ms"]
      }
    },
    metadata: {
      help: "agent sleep <ms>"
    }
  }
];
