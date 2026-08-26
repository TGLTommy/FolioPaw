import axios from 'axios';
import { runtimeConfig } from '../config/env';

export interface DictionaryResult {
    word: string;
    phonetic?: string;
    phoneticUs?: string;  // US phonetic
    phoneticUk?: string;  // UK phonetic
    translation: string[];
    found: boolean;
}

/**
 * Dictionary Service using iCiba API (金山词霸)
 * Free API, no authentication required
 */
export class DictionaryService {
    private readonly baseUrl = runtimeConfig.dictionaryApiUrl;

    /**
     * Look up a word in the dictionary
     */
    async lookup(word: string): Promise<DictionaryResult> {
        if (!word || word.trim() === '') {
            return {
                word: '',
                translation: [],
                found: false,
            };
        }

        const cleanWord = word.trim().toLowerCase();

        if (!this.baseUrl) {
            return {
                word: cleanWord,
                translation: [],
                found: false,
            };
        }

        try {
            // Use iCiba's mobile API
            const response = await axios.get(this.baseUrl, {
                params: {
                    c: 'word',
                    m: 'getsuggest',
                    nums: 1,
                    is_need_mean: 1,
                    word: cleanWord,
                },
                timeout: 5000,
                headers: {
                    'User-Agent': 'FolioPaw/1.0',
                },
            });

            const data = response.data;

            if (data.status === 1 && data.message && data.message.length > 0) {
                const result = data.message[0];

                // Parse the means (translations)
                const translations: string[] = [];
                if (result.means) {
                    // means can be a string or array
                    if (typeof result.means === 'string') {
                        translations.push(result.means);
                    } else if (Array.isArray(result.means)) {
                        result.means.forEach((mean: any) => {
                            if (typeof mean === 'string') {
                                translations.push(mean);
                            } else if (mean.part && mean.means) {
                                // Format: "n. 影响；冲击"
                                const parts = Array.isArray(mean.means) ? mean.means.join('；') : mean.means;
                                translations.push(`${mean.part} ${parts}`);
                            }
                        });
                    }
                }

                return {
                    word: result.key || cleanWord,
                    phonetic: result.ph_am || result.ph_en || undefined,
                    phoneticUs: result.ph_am || undefined,
                    phoneticUk: result.ph_en || undefined,
                    translation: translations,
                    found: translations.length > 0,
                };
            }

            return {
                word: cleanWord,
                translation: [],
                found: false,
            };
        } catch {
            return {
                word: cleanWord,
                translation: [],
                found: false,
            };
        }
    }

    /**
     * Look up multiple words
     */
    async lookupMultiple(words: string[]): Promise<DictionaryResult[]> {
        const results = await Promise.all(
            words.map(word => this.lookup(word))
        );
        return results;
    }
}

export const dictionaryService = new DictionaryService();
