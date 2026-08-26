import EPub from 'epub';
import path from 'path';
import fs from 'fs';
import { runtimeConfig } from '../config/env';
import { extractEpubSafely, openValidatedEpub } from './epub-security.service';

export interface EPUBPage {
  pageNumber: number;
  text: string;
  chapterId?: string;
}

export interface TOCEntry {
  id: string;
  title: string;
  href: string;
  level: number;
  pageNumber?: number;
  children?: TOCEntry[];
}

/**
 * 将图片相对路径转换为EPUB内部的规范化路径
 * @param imageSrc - XHTML中的原始src (例: "../Images/foo.png")
 * @param chapterHref - 章节在manifest中的href (例: "Text/chapter-1.xhtml")
 * @returns 规范化路径 (例: "Images/foo.png")
 */
function normalizeImagePath(imageSrc: string, chapterHref: string): string {
  // 移除URL片段标识符和查询字符串
  const cleanSrc = imageSrc.split('#')[0].split('?')[0];

  // 获取章节所在目录
  const chapterDir = path.dirname(chapterHref);

  // 解析相对路径
  const resolved = path.join(chapterDir, cleanSrc);

  // 规范化为正斜杠 (EPUB标准)
  const normalized = resolved.replace(/\\/g, '/');

  // 移除开头的 './'
  return normalized.replace(/^\.\//, '');
}

/**
 * 使用多策略在manifest中查找图片
 * 策略1: 精确匹配 (用于绝对路径)
 * 策略2: 规范化路径匹配 (解析相对路径)
 * 策略3: 仅文件名匹配 (最后手段)
 */
function findImageInManifest(
  originalSrc: string,
  chapterHref: string,
  manifest: any
): string | null {
  // 策略1: 精确匹配
  let imageId = Object.keys(manifest).find(key => {
    const href = manifest[key].href;
    return href === originalSrc;
  });
  if (imageId) {
    return imageId;
  }

  // 策略2: 规范化路径匹配
  const normalizedSrc = normalizeImagePath(originalSrc, chapterHref);
  imageId = Object.keys(manifest).find(key => {
    const href = manifest[key].href;
    if (!href) return false;

    const normalizedHref = href.replace(/\\/g, '/').replace(/^\.\//, '');

    // 尝试多种匹配方式
    return normalizedHref === normalizedSrc ||
           normalizedHref === originalSrc.replace(/^\.\.\//, '') ||
           normalizedHref.endsWith('/' + normalizedSrc) ||
           ('OEBPS/' + normalizedSrc) === normalizedHref ||
           ('OPS/' + normalizedSrc) === normalizedHref;
  });
  if (imageId) {
    return imageId;
  }

  // 策略3: 仅文件名匹配 (用于格式不规范的EPUB)
  const filename = path.basename(originalSrc);
  imageId = Object.keys(manifest).find(key => {
    const href = manifest[key].href;
    return href && path.basename(href) === filename;
  });
  if (imageId) {
    return imageId;
  }

  return null;
}

export interface ParsedEpub {
  pages: EPUBPage[];
  totalPages: number;
  toc: TOCEntry[];
  coverImagePath: string | null;
  createdResourcePaths: string[];
}

export async function parseEPUB(filePath: string): Promise<ParsedEpub> {
  const validatedZip = openValidatedEpub(filePath);
  const epub = new EPub(filePath);
  let tempDir = '';
  const createdResourcePaths: string[] = [];

  try {
          await epub.parse();
          const pages: EPUBPage[] = [];
          const chapters = epub.flow;
          const chapterPageMapping: { [chapterId: string]: number } = {};
          const hrefToChapterIdMapping: { [href: string]: string } = {};

          let pageNumber = 1;

          // Prepare uploads directory for EPUB resources
          const uploadsDir = runtimeConfig.uploadDir;
          const epubResourcesDir = path.join(uploadsDir, 'epub-resources');
          if (!fs.existsSync(epubResourcesDir)) {
            fs.mkdirSync(epubResourcesDir, { recursive: true });
          }

          // Get manifest and prepare cover image mapping
          const manifest = (epub as any).manifest;
          const coverImageId = Object.keys(manifest).find(key =>
            manifest[key].properties === 'cover-image' ||
            key === 'cover-image' ||
            manifest[key].id === 'cover-image'
          );
          let coverImagePath: string | null = null;

          if (coverImageId) {
            try {
              const coverImageExt = path.extname(manifest[coverImageId].href) || '.jpg';
              coverImagePath = `epub-resources/${Date.now()}-cover${coverImageExt}`;
              const fullCoverImagePath = path.join(uploadsDir, coverImagePath);

              const coverData = (await epub.getImage(coverImageId)).data;

              if (coverData && Buffer.isBuffer(coverData)) {
                fs.writeFileSync(fullCoverImagePath, coverData);
                createdResourcePaths.push(fullCoverImagePath);
              }
            } catch {
              console.warn('EPUB cover image could not be extracted');
            }
          }

          // Extract EPUB to temp directory to read raw XHTML files
          tempDir = fs.mkdtempSync(path.join(uploadsDir, 'epub-temp-'));
          extractEpubSafely(validatedZip, tempDir);

          for (const chapter of chapters) {
            // Read chapter XHTML file directly instead of using epub.getChapter()
            // which strips out src attributes from img tags
            let chapterHtml = '';

            // Find the chapter file path from manifest
            const chapterManifest = manifest[chapter.id];
            if (!chapterManifest?.href) {
              console.warn('EPUB chapter is missing a manifest path');
            }
            if (chapterManifest && chapterManifest.href) {
              // EPUB chapters are usually in OEBPS or similar directory
              const possiblePaths = [
                path.join(tempDir, 'OEBPS', chapterManifest.href),
                path.join(tempDir, 'OPS', chapterManifest.href),
                path.join(tempDir, chapterManifest.href),
                path.join(tempDir, 'content', chapterManifest.href)
              ];

              for (const possiblePath of possiblePaths) {
                if (fs.existsSync(possiblePath)) {
                  chapterHtml = fs.readFileSync(possiblePath, 'utf-8');
                  break;
                }
              }

              if (!chapterHtml) {
                console.warn('EPUB chapter file was not found at its declared path; using parser fallback');
                // Fallback to epub.getChapter
                chapterHtml = await epub.getChapter(chapter.id);
              }
            } else {
              // Fallback to epub.getChapter
              chapterHtml = await epub.getChapter(chapter.id);
            }

            // 1. Extract and replace images
            // Use a more robust approach: find all image-like tags and process their src/href attributes
            const imgTagRegex = /<(img|image)([^>]*)>/gi;
            // Support multiple href formats: src, href, xlink:href
            const srcAttrRegex = /(src|href|xlink:href)=["']([^"']+)["']/i;

            // Process images synchronously to ensure proper replacements
            let updatedHtml = chapterHtml;
            const matches = Array.from(chapterHtml.matchAll(imgTagRegex));


            for (const match of matches) {
              const tagName = match[1];  // 'img' or 'image'
              const attributes = match[2];  // all attributes
              const fullTag = match[0];  // complete tag
              const srcMatch = attributes.match(srcAttrRegex);

              // Check if this is a cover image without src
              const isCoverImage = /role=["']doc-cover["']/.test(attributes) ||
                                   /epub:type=["']cover["']/.test(fullTag);

              if (srcMatch) {
                const attrName = srcMatch[1];  // 'src' or 'xlink:href'
                const originalSrc = srcMatch[2];  // path to image


                // 使用增强匹配查找图片
                const imageId = chapterManifest?.href
                  ? findImageInManifest(originalSrc, chapterManifest.href, manifest)
                  : null;

                if (imageId) {
                  try {
                    const imagePath = `epub-resources/${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(originalSrc) || '.jpg'}`;
                    const fullImagePath = path.join(uploadsDir, imagePath);

                    const data = (await epub.getImage(imageId)).data;

                    if (data && Buffer.isBuffer(data)) {
                      fs.writeFileSync(fullImagePath, data);
                      createdResourcePaths.push(fullImagePath);
                      const newUrl = `/uploads/${imagePath}`;

                      // Check if this is a self-closing tag
                      const isSelfClosing = /\/$/.test(attributes.trim());

                      // Remove trailing slash from attributes if present
                      const cleanAttributes = attributes.replace(/\s*\/$/, '');

                      // Replace the entire src/href attribute value in the tag
                      let newAttributes = cleanAttributes.replace(
                        new RegExp(`(${attrName})=["'][^"']*["']`, 'i'),
                        `$1="${newUrl}"`
                      );

                      // For SVG <image> tags, ensure both href and xlink:href are present for browser compatibility
                      if (tagName.toLowerCase() === 'image' && attrName.toLowerCase() === 'href') {
                        // Check if xlink:href already exists
                        if (!/ xlink:href=/i.test(newAttributes)) {
                          // Add xlink:href attribute
                          newAttributes += ` xlink:href="${newUrl}"`;
                        }
                      }

                      // Reconstruct the tag with proper closing
                      const newTag = isSelfClosing
                        ? `<${tagName}${newAttributes}/>`
                        : `<${tagName}${newAttributes}>`;
                      updatedHtml = updatedHtml.replace(fullTag, newTag);

                    }
                  } catch {
                    console.warn('EPUB chapter image could not be extracted');
                  }
                } else {
                  console.warn('EPUB chapter image was not found in the manifest');
                }
              } else if (isCoverImage && coverImagePath) {
                // Handle cover image without src attribute
                const newUrl = `/uploads/${coverImagePath}`;
                const newAttributes = attributes + ` src="${newUrl}"`;
                const newTag = `<${tagName}${newAttributes}>`;
                updatedHtml = updatedHtml.replace(fullTag, newTag);
              } else {
                console.warn('EPUB contains an image element without a source');
              }
            }

            chapterHtml = updatedHtml;

            // 2. Process HTML for rendering
            // Remove scripts but keep layout tags
            const processedHtml = chapterHtml
              .replace(/<script[^>]*>.*?<\/script>/gi, '')
              .replace(/<style[^>]*>.*?<\/style>/gi, '') // Keep styles? Maybe not to avoid global pollution
              .trim();

            // Simple splitting by block tags to avoid breaking HTML structures
            // We'll split by </p>, </div>, </li>, </h[1-6]>
            const blockTags = ['</p>', '</div>', '</li>', '</h1>', '</h2>', '</h3>', '</h4>', '</h5>', '</h6>'];
            const chunks: string[] = [];
            let currentChunk = '';
            const maxCharsPerPage = 3000;

            // Use a simple split then join approach
            const parts = processedHtml.split(/(<\/[^>]+>)/g);
            for (const part of parts) {
              currentChunk += part;
              if (currentChunk.length > maxCharsPerPage && blockTags.some(tag => part.toLowerCase().includes(tag))) {
                chunks.push(currentChunk);
                currentChunk = '';
              }
            }
            if (currentChunk.trim()) {
              chunks.push(currentChunk);
            }

            for (const chunk of chunks) {
              if (chunk.trim()) {
                pages.push({
                  pageNumber: pageNumber++,
                  text: chunk.trim(),
                  chapterId: chapter.id
                });
              }
            }

            // Store the first page number for this chapter
            chapterPageMapping[chapter.id] = pages.find(p => p.chapterId === chapter.id)?.pageNumber || pageNumber;

            // Also create a mapping from chapter's href-like identifier to its ID
            if (chapter.href) {
              hrefToChapterIdMapping[chapter.href] = chapter.id;
            }
          }

          // Build TOC from EPUB structure
          const toc = buildTableOfContents(epub, chapterPageMapping, hrefToChapterIdMapping);

          // Clean up temporary directory
          try {
            if (fs.existsSync(tempDir)) {
              fs.rmSync(tempDir, { recursive: true, force: true });
            }
          } catch {
            console.warn('EPUB temporary directory cleanup failed');
          }

          return {
            pages,
            totalPages: pages.length,
            toc,
            coverImagePath: coverImagePath ? `/uploads/${coverImagePath}` : null,
            createdResourcePaths: [...createdResourcePaths],
          };
        } catch (error) {
          // Clean up temporary directory on error
          try {
            if (tempDir && fs.existsSync(tempDir)) {
              fs.rmSync(tempDir, { recursive: true, force: true });
            }
          } catch {
            console.warn('EPUB temporary directory cleanup failed after a parser error');
          }
          for (const resourcePath of createdResourcePaths) {
            try {
              fs.rmSync(resourcePath, { force: true });
            } catch {
              // Best-effort cleanup; the original parsing error remains primary.
            }
          }
          throw new Error(`EPUB 章节解析失败: ${error}`);
        }
}

/**
 * Build table of contents from EPUB structure
 */
function buildTableOfContents(
  epub: any,
  chapterPageMapping: { [chapterId: string]: number },
  hrefToChapterIdMapping: { [href: string]: string }
): TOCEntry[] {
  const toc: TOCEntry[] = [];

  if (!epub.toc || !Array.isArray(epub.toc)) {
    return toc;
  }

  const processNode = (node: any, level: number = 0): TOCEntry | null => {
    if (!node) return null;

    let pageNumber: number | undefined = undefined;

    // Try multiple strategies to find the page number:
    // 1. Try using node.id directly
    if (node.id && chapterPageMapping[node.id]) {
      pageNumber = chapterPageMapping[node.id];
    }
    // 2. Try matching by href
    else if (node.href) {
      // First try exact href match
      if (hrefToChapterIdMapping[node.href]) {
        const chapterId = hrefToChapterIdMapping[node.href];
        pageNumber = chapterPageMapping[chapterId];
      }
      // If no exact match, try to find a chapter by matching the filename
      else {
        // Extract the base filename from href (e.g., "folder/chapter1.html#section" -> "chapter1")
        const hrefMatch = node.href.match(/([^/]+?)(?:#.*)?$/);
        if (hrefMatch) {
          const hrefBasename = hrefMatch[1];
          // Look for a matching chapter href
          for (const [chapHref, chapId] of Object.entries(hrefToChapterIdMapping)) {
            if (chapHref.includes(hrefBasename)) {
              pageNumber = chapterPageMapping[chapId];
              break;
            }
          }
        }
      }
    }

    const entry: TOCEntry = {
      id: node.id || `toc-${Math.random().toString(36).substr(2, 9)}`,
      title: node.title || '',
      href: node.href || '',
      level,
      pageNumber
    };

    if (node.children && Array.isArray(node.children)) {
      entry.children = node.children
        .map((child: any) => processNode(child, level + 1))
        .filter((child: TOCEntry | null) => child !== null) as TOCEntry[];
    }

    return entry;
  };

  for (const node of epub.toc) {
    const entry = processNode(node, 0);
    if (entry) {
      toc.push(entry);
    }
  }

  return toc;
}
