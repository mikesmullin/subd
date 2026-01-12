import { globals } from '../../common/globals.mjs';
import { Utils } from '../../common/utils.mjs';
import { toolsDefinition } from './tools.mjs';
import { toYaml } from '../../common/yaml-db.mjs';
import { ToolExecutionStatus } from '../agent/controllers/host-container-bridge.mjs';
import puppeteer from 'puppeteer';

export class WebPlugin {
  constructor() {
    globals.pluginsRegistry.set('web', this);
    this.registerTools();
  }

  registerTools() {
    globals.dslRegistry.set('web__fetch', this.fetchWebpage.bind(this));
    globals.dslRegistry.set('web__search', this.searchWeb.bind(this));
  }

  get definition() {
    return toolsDefinition;
  }

  async fetchWebpage(args) {
    let urls, query;
    
    // Handle different argument formats
    if (args.urls) {
        urls = args.urls;
        query = args.query;
    } else if (args.url) {
        urls = [args.url];
        query = args.query;
    } else if (Array.isArray(args)) {
        // If args is array, assume it's [url, query] or just [url]
        if (Array.isArray(args[0])) {
            urls = args[0];
            query = args[1];
        } else {
            urls = [args[0]];
            query = args[1];
        }
    } else if (typeof args === 'string') {
        urls = [args];
    }

    if (!urls) {
        const msg = 'Usage: web.fetch { urls: [], query: "" } or { url: "..." }';
        Utils.logError(msg);
        return {
          status: ToolExecutionStatus.FAILURE,
          error: msg
        };
    }
    if (!Array.isArray(urls)) urls = [urls];

    const format = args.format || 'innertext';
    Utils.logInfo(`Fetching content from ${urls.length} URL(s)${query ? ` for query: "${query}"` : ''} (format: ${format})`);

    const results = [];
    let browser = null;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        for (const url of urls) {
            try {
                // Validate URL format
                new URL(url); 

                const page = await browser.newPage();
                
                // Set user agent to avoid some bot detection
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                
                // Navigate and wait for network idle
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

                let content = '';
                if (format === 'html') {
                    // Clean HTML inside the browser context
                    content = await page.evaluate(() => {
                        // Remove non-content tags
                        const tagsToRemove = ['script', 'style', 'svg', 'noscript', 'iframe', 'link', 'meta', 'head', 'object', 'embed', 'applet'];
                        tagsToRemove.forEach(tag => {
                            document.querySelectorAll(tag).forEach(el => el.remove());
                        });

                                      // Remove comments
                        const treeWalker = document.createTreeWalker(
                            document.body,
                            NodeFilter.SHOW_COMMENT,
                            null,
                            false
                        );
                        const comments = [];
                        while(treeWalker.nextNode()) comments.push(treeWalker.currentNode);
                        comments.forEach(c => c.remove());

                        // Remove style, class, and other non-essential attributes
                        const allowedAttributes = ['href', 'src', 'alt', 'title', 'name', 'value', 'type', 'placeholder'];
                        const allElements = document.body.querySelectorAll('*');
                        for (const el of allElements) {
                            const attrs = el.attributes;
                            for (let i = attrs.length - 1; i >= 0; i--) {
                                const attrName = attrs[i].name;
                                if (!allowedAttributes.includes(attrName)) {
                                    el.removeAttribute(attrName);
                                }
                            }
                            
                            // Remove src if it is a data URI
                            if (el.hasAttribute('src')) {
                                const src = el.getAttribute('src');
                                if (src && src.trim().startsWith('data:')) {
                                    el.removeAttribute('src');
                                }
                            }
                        }

                        // Return cleaned HTML
                        return document.body.innerHTML;
                    });
                    
                    // Simple whitespace cleanup
                    content = content.replace(/\s+/g, ' ').trim();
                } else {
                    // Get innerText (human readable)
                    content = await page.evaluate(() => document.body.innerText);
                }
                
                await page.close();

                // Filter content based on query
                const relevantContent = query ? this.filterContentByQuery(content, query) : content;

                results.push({
                    url,
                    content: relevantContent,
                    success: true
                });

            } catch (error) {
                Utils.logError(`Error fetching ${url}: ${error.message}`);
                results.push({
                    url,
                    error: error.message,
                    success: false
                });
            }
        }
    } catch (e) {
        Utils.logError(`Browser error: ${e.message}`);
    } finally {
        if (browser) await browser.close();
    }

    // Format response
    const successfulResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);

    let response = '';

    if (successfulResults.length > 0) {
      for (const result of successfulResults) {
        response += `Here is some relevant context from the web page ${result.url}:\n\n`;
        response += result.content;
        response += '\n\n';
      }
    }

    if (failedResults.length > 0) {
      response += '\nErrors encountered:\n';
      for (const result of failedResults) {
        response += `- ${result.url}: ${result.error}\n`;
      }
    }

    if (successfulResults.length === 0) {
      Utils.logInfo('No content could be retrieved from the provided URLs.');
      return {
        status: ToolExecutionStatus.FAILURE,
        error: 'No content could be retrieved from the provided URLs.'
      };
    }

    Utils.logInfo(response.trim());
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: response.trim()
    };
  }

  extractMainContent(html) {
    if (!html || typeof html !== 'string') {
      return '';
    }

    // Remove script and style tags
    let content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // Remove HTML comments
    content = content.replace(/<!--[\s\S]*?-->/g, '');

    // Try to extract content from semantic HTML elements first
    const semanticElements = [
      'main', 'article', 'section', 'div[role="main"]',
      '.content', '.main-content', '.article-content', '.post-content'
    ];

    for (const selector of semanticElements) {
      // Simple regex for tag matching (not perfect but works for simple cases)
      // Note: A real DOM parser would be better but we want to avoid heavy dependencies if possible
      // or use a lightweight one. v2 used regex.
      const tagName = selector.split(/[.\[]/)[0];
      if (tagName && !tagName.startsWith('.')) {
          const match = content.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\/${tagName}>`, 'i'));
          if (match && match[1].trim().length > 200) {
            content = match[1];
            break;
          }
      }
    }

    // Remove remaining HTML tags
    content = content.replace(/<[^>]*>/g, ' ');

    // Decode HTML entities
    content = content.replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
      .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));

    // Clean up whitespace
    content = content.replace(/\s+/g, ' ').trim();

    // Limit content length to prevent overwhelming responses
    if (content.length > 8000) {
      content = content.substring(0, 8000) + '...';
    }

    return content;
  }

  filterContentByQuery(content, query) {
    if (!content || !query || typeof content !== 'string') {
      return content || '';
    }

    const queryTerms = query.toLowerCase().split(/\s+/).filter(term => term.length > 2);
    if (queryTerms.length === 0) return content;

    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
    const relevantSentences = [];
    const contentLower = content.toLowerCase();

    // First, look for sentences containing query terms
    for (const sentence of sentences) {
      const sentenceLower = sentence.toLowerCase();
      let relevanceScore = 0;

      for (const term of queryTerms) {
        if (sentenceLower.includes(term)) {
          relevanceScore++;
        }
      }

      if (relevanceScore > 0) {
        relevantSentences.push({
          text: sentence.trim(),
          score: relevanceScore
        });
      }
    }

    // If we found relevant sentences, return them sorted by relevance
    if (relevantSentences.length > 0) {
      relevantSentences.sort((a, b) => b.score - a.score);
      let filteredContent = relevantSentences.slice(0, 10).map(s => s.text).join('. ');

      // If the filtered content is too short, include more context
      if (filteredContent.length < 500 && content.length > filteredContent.length) {
        // Try to include surrounding context
        const contextLength = Math.min(2000, content.length);
        const startPos = Math.max(0, contentLower.indexOf(queryTerms[0]) - 200);
        filteredContent = content.substring(startPos, startPos + contextLength);
        if (startPos > 0) filteredContent = '...' + filteredContent;
        if (startPos + contextLength < content.length) filteredContent += '...';
      }

      return filteredContent;
    }

    // If no specific matches, return the beginning of the content
    return content.length > 2000 ? content.substring(0, 2000) + '...' : content;
  }

  async searchWeb(args) {
    const query = typeof args === 'string' ? args : args.query;
    if (!query) {
      const msg = 'Usage: web.search { query: "..." }';
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    const cx = process.env.GOOGLE_CX;

    if (!apiKey || !cx) {
        const msg = 'Missing GOOGLE_API_KEY or GOOGLE_CX environment variables';
        Utils.logError(msg);
        return {
          status: ToolExecutionStatus.FAILURE,
          error: msg
        };
    }

    Utils.logInfo(`Searching web for: "${query}"`);

    try {
        const url = new URL("https://www.googleapis.com/customsearch/v1");
        url.searchParams.append("key", apiKey);
        url.searchParams.append("cx", cx);
        url.searchParams.append("q", query);
        
        const response = await fetch(url.toString());
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Google API error ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        
        if (!data.items || data.items.length === 0) {
            return {
              status: ToolExecutionStatus.SUCCESS,
              result: "No results found."
            };
        }

        const results = data.items.map(item => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet
        }));

        const yamlOutput = toYaml(results);
        Utils.logInfo(`Found ${results.length} results:\n${yamlOutput}`);
        return {
          status: ToolExecutionStatus.SUCCESS,
          result: yamlOutput
        };

    } catch (error) {
        Utils.logError(`Search failed: ${error.message}`);
        return {
          status: ToolExecutionStatus.FAILURE,
          error: `Search failed: ${error.message}`
        };
    }
  }
}

export const webPlugin = new WebPlugin();
