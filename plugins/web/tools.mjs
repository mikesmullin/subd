export const toolsDefinition = [
  {
    type: "function",
    function: {
      name: "web__fetch",
      description: "Fetch content from a webpage",
      parameters: {
        type: "object",
        properties: { 
          url: { type: "string" },
          format: { type: "string", enum: ["innertext", "html"], description: "Output format: 'innertext' (default) or 'html' (simplified)" }
        },
        required: ["url"]
      }
    },
    metadata: { help: "web fetch <url> [format]", requiresHostExecution: true }
  },
  {
    type: "function",
    function: {
      name: "web__search",
      description: "Search the web using Google Custom Search",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    },
    metadata: { help: "web search <query>", requiresHostExecution: true }
  }
];
