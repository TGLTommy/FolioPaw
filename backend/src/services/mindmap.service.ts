import { db } from '../config/database';
import { summaryService } from './summary.service';
import {
  ModelGatewayError,
  modelGateway,
  type ModelExecutionContext,
} from './model-gateway.service';
import {
  textFitsTokenBudget,
  truncateTextToTokenBudget,
} from './model-context-budget.service';
import { assertBookTextAvailable } from './book-text-capability.service';

interface MindmapRecord {
  id: number;
  book_id: number;
  chapter_id: string;
  chapter_title: string | null;
  page_start: number | null;
  page_end: number | null;
  svg_content: string | null;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  error_message: string | null;
  model_used: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Mindmap JSON data structures ───

interface MindmapNode {
  label: string;
  children?: MindmapNode[];
}

interface MindmapData {
  title: string;
  children: MindmapNode[];
}

interface LayoutNode {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  children: LayoutNode[];
}

// ─── AI Prompt (output JSON, not SVG) ───

const MINDMAP_JSON_PROMPT = `你是一位专业的知识可视化专家。请根据以下内容提取核心知识结构，以 JSON 格式输出思维导图数据。

## 输出格式

严格输出如下 JSON（用 \`\`\`json 和 \`\`\` 包裹），不要输出任何其他内容：

\`\`\`json
{
  "title": "中心主题（不超过15字）",
  "children": [
    {
      "label": "一级分支（不超过15字）",
      "children": [
        { "label": "二级节点（不超过20字）" },
        { "label": "二级节点" }
      ]
    }
  ]
}
\`\`\`

## 内容要求
- title: 提取章节核心主题，简洁精炼
- 3-6 个一级分支（关键主题/概念）
- 每个一级分支下 2-4 个二级子节点（具体知识点）
- 所有标题和节点文字必须使用简体中文，简洁精炼，突出重点
- 只输出 JSON，不要输出其他说明文字`;

// ─── JSON extraction & validation ───

function extractJSON(text: string): unknown {
  // Try ```json ... ```
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    return JSON.parse(jsonBlockMatch[1].trim());
  }

  // Try generic ``` ... ```
  const codeBlockMatch = text.match(/```\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return JSON.parse(codeBlockMatch[1].trim());
  }

  // Try raw JSON (find first { to last })
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(text.substring(firstBrace, lastBrace + 1));
  }

  throw new Error('模型返回内容中没有有效的 JSON');
}

function validateMindmapData(raw: unknown): MindmapData {
  const data = raw as any;
  if (!data || typeof data !== 'object') {
    throw new Error('思维导图数据无效：根节点不是对象');
  }

  const title = typeof data.title === 'string' ? data.title.slice(0, 30) : '思维导图';
  const children: MindmapNode[] = [];

  if (Array.isArray(data.children)) {
    for (const child of data.children.slice(0, 8)) {
      const label = typeof child.label === 'string' ? child.label.slice(0, 30) : '分支';
      const subChildren: MindmapNode[] = [];

      if (Array.isArray(child.children)) {
        for (const sub of child.children.slice(0, 6)) {
          const subLabel = typeof sub.label === 'string' ? sub.label.slice(0, 40) : '节点';
          subChildren.push({ label: subLabel });
        }
      }

      children.push({ label, children: subChildren.length > 0 ? subChildren : undefined });
    }
  }

  if (children.length === 0) {
    throw new Error('思维导图数据无效：缺少子节点');
  }

  return { title, children };
}

// ─── Tree layout algorithm ───

const NODE_PADDING_X = 24;
const NODE_PADDING_Y = 12;
const LEVEL_GAP_X = 60;    // horizontal gap between levels
const NODE_GAP_Y = 16;     // vertical gap between sibling nodes
const FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", sans-serif';

function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    // CJK characters are roughly 1.0x fontSize, ASCII roughly 0.6x
    if (ch.charCodeAt(0) > 0x2fff) {
      width += fontSize * 1.0;
    } else {
      width += fontSize * 0.6;
    }
  }
  return width;
}

function getFontSize(depth: number): number {
  if (depth === 0) return 18;
  if (depth === 1) return 14;
  return 12;
}

function buildLayoutTree(data: MindmapData): LayoutNode {
  function build(node: { label: string; children?: MindmapNode[] }, depth: number): LayoutNode {
    const fontSize = getFontSize(depth);
    const textWidth = estimateTextWidth(node.label, fontSize);
    const width = textWidth + NODE_PADDING_X * 2;
    const height = fontSize + NODE_PADDING_Y * 2;

    const children: LayoutNode[] = [];
    if (node.children) {
      for (const child of node.children) {
        children.push(build(child, depth + 1));
      }
    }

    return { label: node.label, x: 0, y: 0, width, height, depth, children };
  }

  return build({ label: data.title, children: data.children }, 0);
}

function getSubtreeHeight(node: LayoutNode): number {
  if (node.children.length === 0) {
    return node.height;
  }
  let totalChildrenHeight = 0;
  for (let i = 0; i < node.children.length; i++) {
    totalChildrenHeight += getSubtreeHeight(node.children[i]);
    if (i < node.children.length - 1) {
      totalChildrenHeight += NODE_GAP_Y;
    }
  }
  return Math.max(node.height, totalChildrenHeight);
}

function assignPositions(node: LayoutNode, x: number, yCenter: number): void {
  node.x = x;
  node.y = yCenter - node.height / 2;

  if (node.children.length === 0) return;

  const childX = x + node.width + LEVEL_GAP_X;
  const totalHeight = node.children.reduce((sum, child, i) => {
    return sum + getSubtreeHeight(child) + (i > 0 ? NODE_GAP_Y : 0);
  }, 0);

  let currentY = yCenter - totalHeight / 2;

  for (const child of node.children) {
    const subtreeH = getSubtreeHeight(child);
    const childYCenter = currentY + subtreeH / 2;
    assignPositions(child, childX, childYCenter);
    currentY += subtreeH + NODE_GAP_Y;
  }
}

// ─── SVG renderer ───

const COLORS = [
  { bg: '#3B82F6', light: '#DBEAFE', border: '#3B82F6', text: '#1E40AF' },
  { bg: '#10B981', light: '#D1FAE5', border: '#10B981', text: '#065F46' },
  { bg: '#8B5CF6', light: '#EDE9FE', border: '#8B5CF6', text: '#5B21B6' },
  { bg: '#F59E0B', light: '#FEF3C7', border: '#F59E0B', text: '#92400E' },
  { bg: '#EF4444', light: '#FEE2E2', border: '#EF4444', text: '#991B1B' },
  { bg: '#06B6D4', light: '#CFFAFE', border: '#06B6D4', text: '#155E75' },
];

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateSVGFromData(data: MindmapData): string {
  const root = buildLayoutTree(data);
  const treeHeight = getSubtreeHeight(root);
  assignPositions(root, 40, treeHeight / 2 + 30);

  // Collect all nodes to determine viewBox
  const allNodes: LayoutNode[] = [];
  function collect(node: LayoutNode) {
    allNodes.push(node);
    node.children.forEach(collect);
  }
  collect(root);

  const minX = Math.min(...allNodes.map(n => n.x)) - 20;
  const minY = Math.min(...allNodes.map(n => n.y)) - 20;
  const maxX = Math.max(...allNodes.map(n => n.x + n.width)) + 20;
  const maxY = Math.max(...allNodes.map(n => n.y + n.height)) + 20;
  const svgWidth = maxX - minX;
  const svgHeight = maxY - minY;

  const elements: string[] = [];

  // Render connections first (below nodes)
  function renderConnections(node: LayoutNode, colorIndex: number) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const ci = node.depth === 0 ? i % COLORS.length : colorIndex;
      const color = COLORS[ci].bg;

      const x1 = node.x + node.width;
      const y1 = node.y + node.height / 2;
      const x2 = child.x;
      const y2 = child.y + child.height / 2;
      const dx = x2 - x1;

      elements.push(
        `<path d="M ${x1} ${y1} C ${x1 + dx * 0.5} ${y1}, ${x2 - dx * 0.5} ${y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2" opacity="0.6"/>`
      );

      renderConnections(child, ci);
    }
  }
  renderConnections(root, 0);

  // Render nodes
  function renderNode(node: LayoutNode, colorIndex: number) {
    const fontSize = getFontSize(node.depth);
    const rx = node.depth === 0 ? 10 : 8;

    if (node.depth === 0) {
      // Root node
      elements.push(
        `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${rx}" fill="#4F46E5" />`
      );
      elements.push(
        `<text x="${node.x + node.width / 2}" y="${node.y + node.height / 2}" text-anchor="middle" dominant-baseline="central" fill="white" font-size="${fontSize}" font-weight="bold" font-family="${FONT_FAMILY}">${escapeXml(node.label)}</text>`
      );
    } else if (node.depth === 1) {
      // L1 node
      const color = COLORS[colorIndex];
      elements.push(
        `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${rx}" fill="${color.bg}" />`
      );
      elements.push(
        `<text x="${node.x + node.width / 2}" y="${node.y + node.height / 2}" text-anchor="middle" dominant-baseline="central" fill="white" font-size="${fontSize}" font-weight="500" font-family="${FONT_FAMILY}">${escapeXml(node.label)}</text>`
      );
    } else {
      // L2 node
      const color = COLORS[colorIndex];
      elements.push(
        `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="6" fill="${color.light}" stroke="${color.border}" stroke-width="1.5" />`
      );
      elements.push(
        `<text x="${node.x + node.width / 2}" y="${node.y + node.height / 2}" text-anchor="middle" dominant-baseline="central" fill="${color.text}" font-size="${fontSize}" font-family="${FONT_FAMILY}">${escapeXml(node.label)}</text>`
      );
    }

    for (let i = 0; i < node.children.length; i++) {
      const ci = node.depth === 0 ? i % COLORS.length : colorIndex;
      renderNode(node.children[i], ci);
    }
  }
  renderNode(root, 0);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}">\n${elements.join('\n')}\n</svg>`;
}

// ─── Service class ───

export class MindmapService {

  /**
   * Get all mindmaps for a book
   */
  getMindmaps(bookId: number): MindmapRecord[] {
    return db.prepare(
      'SELECT * FROM book_mindmaps WHERE book_id = ? ORDER BY page_start ASC'
    ).all(bookId) as MindmapRecord[];
  }

  /**
   * Get a single chapter mindmap
   */
  getMindmap(bookId: number, chapterId: string): MindmapRecord | undefined {
    return db.prepare(
      'SELECT * FROM book_mindmaps WHERE book_id = ? AND chapter_id = ?'
    ).get(bookId, chapterId) as MindmapRecord | undefined;
  }

  /**
   * Generate mindmap for a single chapter
   */
  async generateMindmap(
    bookId: number,
    chapterId: string,
    modelContext?: ModelExecutionContext,
  ): Promise<MindmapRecord> {
    assertBookTextAvailable(bookId);
    const executionContext = modelContext || modelGateway.createContext();
    const ranges = summaryService.calculateChapterRanges(bookId);
    const chapter = ranges.find(r => r.id === chapterId);
    if (!chapter) throw new Error(`章节 ${chapterId} 不存在`);

    // Upsert pending record
    db.prepare(`
      INSERT INTO book_mindmaps (book_id, chapter_id, chapter_title, page_start, page_end, status)
      VALUES (?, ?, ?, ?, ?, 'generating')
      ON CONFLICT(book_id, chapter_id) DO UPDATE SET
        status = 'generating', error_message = NULL, updated_at = CURRENT_TIMESTAMP
    `).run(bookId, chapter.id, chapter.title, chapter.pageStart, chapter.pageEnd);

    try {
      console.log(`[Mindmap] Generating mindmap: "${chapter.title}" (p.${chapter.pageStart}-${chapter.pageEnd})`);

      // Prefer existing summary as input (shorter, more focused)
      let inputContent: string;
      const inputBudget = modelGateway.getInputTokenBudget({
        systemPrompt: MINDMAP_JSON_PROMPT,
        userMessage: '',
        task: '生成用户要求的简体中文书籍思维导图数据。',
        maxTokens: 4000,
        responseFormat: 'json',
      }, executionContext);
      if (inputBudget !== null && inputBudget < 256) {
        throw new ModelGatewayError('当前模型上下文窗口不足以生成思维导图，请增大上下文窗口', 422);
      }
      const contentBudget = inputBudget === null ? null : inputBudget - 128;
      const existingSummary = db.prepare(
        "SELECT summary_text FROM book_summaries WHERE book_id = ? AND summary_type = 'chapter' AND chapter_id = ? AND status = 'completed'"
      ).get(bookId, chapterId) as { summary_text: string } | undefined;

      if (existingSummary?.summary_text) {
        console.log(`[Mindmap] Using existing chapter summary as input`);
        const summaryText = contentBudget === null
          ? existingSummary.summary_text
          : truncateTextToTokenBudget(existingSummary.summary_text, contentBudget);
        inputContent = `章节标题: ${chapter.title}\n\n章节摘要:\n${summaryText}`;
      } else {
        console.log(`[Mindmap] No summary found, using raw chapter content`);
        const content = summaryService.gatherChapterContent(bookId, chapter.pageStart, chapter.pageEnd);
        if (!content.trim()) {
          throw new Error('没有找到可用于生成思维导图的章节内容');
        }
        if (contentBudget !== null && !textFitsTokenBudget(content, contentBudget)) {
          console.log('[Mindmap] Chapter exceeds model context; generating an intermediate summary');
          const intermediate = await summaryService.summarizeContent(
            content,
            '请提取本章的结构、核心观点、重要概念及它们之间的关系，供后续生成思维导图。使用精炼中文。',
            executionContext,
          );
          inputContent = `章节标题: ${chapter.title}\n\n章节摘要:\n${truncateTextToTokenBudget(intermediate.text, contentBudget)}`;
        } else {
          inputContent = `章节标题: ${chapter.title}\n\n章节内容:\n${content}`;
        }
      }

      const { text, model } = await summaryService.callLLM(
        MINDMAP_JSON_PROMPT,
        inputContent,
        4000,
        executionContext,
        'json',
      );
      const rawData = extractJSON(text);
      const mindmapData = validateMindmapData(rawData);
      const svgContent = generateSVGFromData(mindmapData);

      db.prepare(`
        UPDATE book_mindmaps SET svg_content = ?, status = 'completed', model_used = ?, updated_at = CURRENT_TIMESTAMP
        WHERE book_id = ? AND chapter_id = ?
      `).run(svgContent, model, bookId, chapter.id);

      console.log(`[Mindmap] Mindmap completed: "${chapter.title}"`);
      return this.getMindmap(bookId, chapter.id)!;
    } catch (error: any) {
      db.prepare(`
        UPDATE book_mindmaps SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE book_id = ? AND chapter_id = ?
      `).run(error.message, bookId, chapter.id);
      throw error;
    }
  }

  /**
   * Delete all mindmaps for a book
   */
  deleteMindmaps(bookId: number): void {
    db.prepare('DELETE FROM book_mindmaps WHERE book_id = ?').run(bookId);
  }
}

export const mindmapService = new MindmapService();
