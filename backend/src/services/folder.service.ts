import { db } from '../config/database';

export interface Folder {
  id: number;
  user_id: number;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  book_count?: number;
}

export interface CreateFolderDTO {
  name: string;
  color?: string;
}

export interface UpdateFolderDTO {
  name?: string;
  color?: string;
  sort_order?: number;
}

// Get all folders with book count for a specific user
export function getAllFolders(userId: number): Folder[] {
  return db.prepare(`
    SELECT
      f.*,
      COUNT(DISTINCT CASE
        WHEN b.id IS NULL THEN NULL
        ELSE b.original_name || '|' || b.file_type || '|' || b.file_size || '|' || b.total_pages
      END) as book_count
    FROM folders f
    LEFT JOIN user_book_folders ubf ON ubf.folder_id = f.id AND ubf.user_id = ?
    LEFT JOIN books b ON b.id = ubf.book_id
    WHERE f.user_id = ?
    GROUP BY f.id
    ORDER BY f.sort_order ASC, f.created_at DESC
  `).all(userId, userId) as Folder[];
}

// Get a single folder by ID (with user ownership check)
export function getFolderById(id: number, userId: number): Folder | null {
  const folder = db.prepare(`
    SELECT
      f.*,
      COUNT(DISTINCT CASE
        WHEN b.id IS NULL THEN NULL
        ELSE b.original_name || '|' || b.file_type || '|' || b.file_size || '|' || b.total_pages
      END) as book_count
    FROM folders f
    LEFT JOIN user_book_folders ubf ON ubf.folder_id = f.id AND ubf.user_id = ?
    LEFT JOIN books b ON b.id = ubf.book_id
    WHERE f.id = ? AND f.user_id = ?
    GROUP BY f.id
  `).get(userId, id, userId) as Folder | undefined;
  return folder || null;
}

// Create a new folder for a user
export function createFolder(userId: number, data: CreateFolderDTO): Folder {
  // Check if name already exists for this user
  const existing = db.prepare('SELECT id FROM folders WHERE name = ? AND user_id = ?').get(data.name, userId);
  if (existing) {
    throw new Error('文件夹名称已存在');
  }

  // Get max sort_order for this user
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM folders WHERE user_id = ?').get(userId) as { max: number | null };
  const sortOrder = (maxOrder?.max || 0) + 1;

  const result = db.prepare(`
    INSERT INTO folders (user_id, name, color, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(
    userId,
    data.name.trim(),
    data.color || '#3B82F6',
    sortOrder
  );

  return getFolderById(result.lastInsertRowid as number, userId)!;
}

// Update a folder (with user ownership check)
export function updateFolder(id: number, userId: number, data: UpdateFolderDTO): Folder {
  const folder = getFolderById(id, userId);
  if (!folder) {
    throw new Error('文件夹不存在');
  }

  // If changing name, check for duplicates within this user's folders
  if (data.name && data.name !== folder.name) {
    const existing = db.prepare('SELECT id FROM folders WHERE name = ? AND user_id = ? AND id != ?').get(data.name, userId, id);
    if (existing) {
      throw new Error('文件夹名称已存在');
    }
  }

  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (data.name !== undefined) {
    updates.push('name = ?');
    values.push(data.name.trim());
  }
  if (data.color !== undefined) {
    updates.push('color = ?');
    values.push(data.color);
  }
  if (data.sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(data.sort_order);
  }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    values.push(userId);
    db.prepare(`UPDATE folders SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
  }

  return getFolderById(id, userId)!;
}

// Delete a folder (with user ownership check, also clean up user_book_folders)
export function deleteFolder(id: number, userId: number): void {
  const folder = getFolderById(id, userId);
  if (!folder) {
    throw new Error('文件夹不存在');
  }

  // Clear folder references in user_book_folders for this user
  db.prepare('UPDATE user_book_folders SET folder_id = NULL WHERE folder_id = ? AND user_id = ?').run(id, userId);

  // Delete the folder
  db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(id, userId);
}

// Get count of uncategorized books for a user
export function getUncategorizedBookCount(userId: number): number {
  const result = db.prepare(`
    SELECT COUNT(DISTINCT b.original_name || '|' || b.file_type || '|' || b.file_size || '|' || b.total_pages) as count
    FROM books b
    WHERE NOT EXISTS (
      SELECT 1
      FROM books folder_book
      INNER JOIN user_book_folders ubf ON ubf.book_id = folder_book.id
      WHERE ubf.user_id = ?
        AND ubf.folder_id IS NOT NULL
        AND folder_book.original_name = b.original_name
        AND folder_book.file_type = b.file_type
        AND folder_book.file_size = b.file_size
        AND folder_book.total_pages = b.total_pages
    )
  `).get(userId) as { count: number };
  return result?.count || 0;
}
