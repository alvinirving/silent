export class HTMLCleaner {
    private tagsToRemove: string[];
    private attributesToRemove: string[];

    /**
     * Creates an instance of HTMLCleaner.
     * @param {string[]} [tagsToRemove] - Array of HTML tags to remove from the content
     * @param {string[]} [attributesToRemove] - Array of HTML attributes to remove from remaining elements
     */
    constructor(tagsToRemove?: string[], attributesToRemove?: string[]) {
        this.tagsToRemove = tagsToRemove || ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'video', 'audio', 'img', 'nav', 'aside', 'footer', 'header'];
        this.attributesToRemove = attributesToRemove || ['onclick', 'onload', 'onerror', 'onmouseover', 'onmouseout'];
        
        // Apply deduplication to all methods
        this.applyDeduplicationToAllMethods();
    }

    /**
     * Cleans HTML content by removing specified tags and attributes, returning only text content.
     * @param {string} html - The HTML content to clean
     * @returns {string} Cleaned text content with excess whitespace removed
     */
    clean(html: string): string {
        let tempElement = document.createElement('div');
        tempElement.innerHTML = html;

        this.tagsToRemove.forEach(tag => {
            let elements = tempElement.querySelectorAll(tag);
            elements.forEach(el => el.remove());
        });

        var allElements = tempElement.querySelectorAll('*');
        allElements.forEach(el => {
            this.attributesToRemove.forEach(attr => el.removeAttribute(attr));
        });

        let textContent = tempElement.textContent || "";
        textContent = textContent.replace(/\s+/g, ' ').trim();
        return this.deduplicateFinalOutput(textContent);
    }

    /**
     * Extracts text content from semantically important HTML elements.
     * @param {string} html - The HTML content to process
     * @returns {string} Concatenated text content from semantic elements with line breaks
     */
    cleanSemantic(html: string): string {
        let tempElement = document.createElement('div');
        tempElement.innerHTML = html;
        let importantText = "";
        var importantTags = ['article', 'main', 'section', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'code', 'pre', 'em', 'strong', 'a'];
        importantTags.forEach(tag => {
            let elements = tempElement.querySelectorAll(tag);
            elements.forEach(el => {
                importantText += (el.textContent || "") + "\n\n";
            });
        });
        importantText = importantText.replace(/\s+/g, ' ').trim();
        return this.deduplicateFinalOutput(importantText);
    }

    /**
     * Extracts information about interactive elements from HTML content.
     * @param {string} html - The HTML content to process
     * @returns {string} Formatted string containing information about interactive elements
     */
    cleanForInteractive(html: string): string {
        let tempElement = document.createElement('div');
        tempElement.innerHTML = html;
        
        var interactiveElements = new Set([
            'a', 'button', 'input', 'select', 'textarea',
            'details', 'menu', 'menuitem'
        ]);

        var interactiveRoles = new Set([
            'button', 'link', 'checkbox', 'radio',
            'tab', 'menuitem', 'option', 'switch'
        ]);

        let interactiveContent = "";
        
        var processElement = (element: Element) => {
            var tagName = element.tagName.toLowerCase();
            var role = element.getAttribute('role');
            
            if (interactiveElements.has(tagName) || 
                (role && interactiveRoles.has(role))) {
                // Special handling for input elements
                if (tagName === 'input') {
                    var value = (element as HTMLInputElement).value;
                    interactiveContent += `[${tagName}] ${value}\n`;
                } else {
                    interactiveContent += `[${tagName}] ${element.textContent}\n`;
                }
            }
        };

        tempElement.querySelectorAll('*').forEach(processElement);
        return this.deduplicateFinalOutput(interactiveContent.trim());
    }

    /**
     * Preserves the hierarchical structure of HTML content, focusing on headings and paragraphs.
     * @param {string} html - The HTML content to process
     * @returns {string} Indented text representation of the document's semantic structure
     */
    preserveSemanticHierarchy(html: string): string {
        let tempElement = document.createElement('div');
        tempElement.innerHTML = html;

        var headingLevels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
        let structuredContent = "";
        
        var processNode = (element: Element, depth: number = 0) => {
            var tagName = element.tagName.toLowerCase();
            var indent = '  '.repeat(depth);
            
            if (headingLevels.includes(tagName)) {
                structuredContent += `${indent}${tagName}: ${element.textContent}\n`;
            } else if (tagName === 'p' || tagName === 'article') {
                structuredContent += `${indent}${element.textContent}\n`;
            }
            
            Array.from(element.children).forEach(child => processNode(child, depth + 1));
        };

        processNode(tempElement);
        return this.deduplicateFinalOutput(structuredContent.trim());
    }

    /**
     * Deduplicates the final output to remove repeated paragraphs and sections
     * @param {string} text - The text to deduplicate
     * @returns {string} Deduplicated text
     */
    private deduplicateFinalOutput(text: string): string {
        // Split text into paragraphs
        var paragraphs = text.split(/\n{2,}|\r\n{2,}/);
        var uniqueParagraphs: string[] = [];
        var seenParagraphs = new Set<string>();
        
        // Process each paragraph
        for (var paragraph of paragraphs) {
            var trimmed = paragraph.trim();
            
            // Skip empty paragraphs
            if (!trimmed) continue;
            
            // Skip if we've seen this exact paragraph before
            if (seenParagraphs.has(trimmed)) continue;
            
            // Check for near-duplicate paragraphs (>80% similarity)
            let isDuplicate = false;
            for (var existing of seenParagraphs) {
                if (this.calculateSimilarity(trimmed, existing) > 0.8) {
                    isDuplicate = true;
                    break;
                }
            }
            
            if (!isDuplicate) {
                uniqueParagraphs.push(trimmed);
                seenParagraphs.add(trimmed);
            }
        }
        
        // Join unique paragraphs back together
        return uniqueParagraphs.join('\n\n');
    }

    /**
     * Calculates similarity between two strings (0-1 scale)
     * @private
     * @param {string} str1 - First string to compare
     * @param {string} str2 - Second string to compare
     * @returns {number} Similarity score between 0 and 1
     */
    private calculateSimilarity(str1: string, str2: string): number {
        // If either string is empty, return 0
        if (!str1.length || !str2.length) return 0;
        
        // If strings are identical, return 1
        if (str1 === str2) return 1;
        
        // If one string contains the other, return a high similarity
        if (str1.includes(str2) || str2.includes(str1)) {
            return 0.9;
        }
        
        // Calculate Levenshtein distance
        var len1 = str1.length;
        var len2 = str2.length;
        
        // Use a simplified approach for long strings to avoid performance issues
        if (len1 > 100 || len2 > 100) {
            // Compare first 50 chars, middle 50 chars, and last 50 chars
            var compareStart = this.calculateLevenshteinSimilarity(
                str1.substring(0, 50), 
                str2.substring(0, 50)
            );
            
            var mid1Start = Math.max(0, Math.floor(len1 / 2) - 25);
            var mid2Start = Math.max(0, Math.floor(len2 / 2) - 25);
            var compareMiddle = this.calculateLevenshteinSimilarity(
                str1.substring(mid1Start, mid1Start + 50), 
                str2.substring(mid2Start, mid2Start + 50)
            );
            
            var compareEnd = this.calculateLevenshteinSimilarity(
                str1.substring(Math.max(0, len1 - 50)), 
                str2.substring(Math.max(0, len2 - 50))
            );
            
            // Average the three similarity scores
            return (compareStart + compareMiddle + compareEnd) / 3;
        }
        
        // For shorter strings, calculate full Levenshtein similarity
        return this.calculateLevenshteinSimilarity(str1, str2);
    }

    /**
     * Calculates Levenshtein similarity between two strings
     * @private
     * @param {string} str1 - First string to compare
     * @param {string} str2 - Second string to compare
     * @returns {number} Similarity score between 0 and 1
     */
    private calculateLevenshteinSimilarity(str1: string, str2: string): number {
        var len1 = str1.length;
        var len2 = str2.length;
        
        // Create a matrix of size (len1+1) x (len2+1)
        var matrix: number[][] = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
        
        // Initialize the first row and column
        for (let i = 0; i <= len1; i++) {
            matrix[i][0] = i;
        }
        
        for (let j = 0; j <= len2; j++) {
            matrix[0][j] = j;
        }
        
        // Fill the matrix
        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                var cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,      // deletion
                    matrix[i][j - 1] + 1,      // insertion
                    matrix[i - 1][j - 1] + cost // substitution
                );
            }
        }
        
        // Calculate similarity as 1 - (distance / max length)
        var distance = matrix[len1][len2];
        var maxLength = Math.max(len1, len2);
        return 1 - (distance / maxLength);
    }

    /**
     * Applies deduplication to all cleaning methods
     */
    private applyDeduplicationToAllMethods(): void {
        // Store original methods
        var originalClean = this.clean;
        var originalCleanSemantic = this.cleanSemantic;
        var originalCleanForInteractive = this.cleanForInteractive;
        var originalPreserveSemanticHierarchy = this.preserveSemanticHierarchy;
        
        // Override methods to apply deduplication
        this.clean = (html: string): string => {
            return this.deduplicateFinalOutput(originalClean.call(this, html));
        };
        
        this.cleanSemantic = (html: string): string => {
            return this.deduplicateFinalOutput(originalCleanSemantic.call(this, html));
        };
        
        this.cleanForInteractive = (html: string): string => {
            return this.deduplicateFinalOutput(originalCleanForInteractive.call(this, html));
        };
        
        this.preserveSemanticHierarchy = (html: string): string => {
            return this.deduplicateFinalOutput(originalPreserveSemanticHierarchy.call(this, html));
        };

    }

    /**
     * Creates a structured representation of HTML with element IDs for easy reference,
     * optimized to reduce noise and focus on meaningful content.
     * @param {string} html - The HTML content to process
     * @param {Object} options - Configuration options
     * @param {boolean} [options.includeCodeBlocks=false] - Whether to include code blocks in the output
     * @param {boolean} [options.includeScripts=false] - Whether to include script content in the output
     * @returns {Object} Object containing the structured content, element mapping, and reference mapping
     */
    cleanWithElementIDs(html: string, options: {
        includeCodeBlocks?: boolean,
        includeScripts?: boolean // Note: script tags are removed by default unless includeScripts=true
    } = {}): {
        content: string,
        elements: Record<string, { type: string, text: string, attributes?: Record<string, string> }>,
        references: Record<string, string | { href?: string, class?: string, selector?: string }>
    } {
        var includeCodeBlocks = options.includeCodeBlocks || false;
        var includeScripts = options.includeScripts || false;

        let tempElement = document.createElement('div');
        // Use DOMParser for potentially more robust parsing, though innerHTML is often fine
        // var parser = new DOMParser();
        // var doc = parser.parseFromString(html, 'text/html');
        // tempElement = doc.body; // Or work directly with doc.body
        tempElement.innerHTML = html; // Sticking with innerHTML for simplicity matching original code

        // --- Initial Cleaning ---

        // 1. Remove unwanted elements BEFORE processing
        this.tagsToRemove.forEach(tag => {
            // Only remove if not explicitly included (like scripts)
            if (tag === 'script' && includeScripts) return;
            // Don't remove interactive elements we want to process
            if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return;

            let elements = tempElement.querySelectorAll(tag);
            elements.forEach(el => el.remove());
        });

        // 2. Clean attributes except important ones
        var allowedAttributes = ['href', 'type', 'value', 'placeholder', 'name', 'checked', 'selected', 'class', 'id', 'for', 'alt', 'title']; // Added for, alt, title
        var allElements = tempElement.querySelectorAll('*');
        allElements.forEach(el => {
            Array.from(el.attributes).forEach(attr => {
                // Allow all data-* attributes? Maybe not needed for LLM.
                // if (!allowedAttributes.includes(attr.name) && !attr.name.startsWith('data-')) {
                if (!allowedAttributes.includes(attr.name)) {
                    el.removeAttribute(attr.name);
                }
            });
        });

        // --- Processing ---

        var elements: Record<string, { type: string, text: string, attributes?: Record<string, string> }> = {};
        var references: Record<string, string | { href?: string, class?: string, selector?: string }> = {};
        let elementCounter = 1;

        // Set to track processed text content to avoid duplicates (mainly for paragraphs/headings)
        var processedTextContent = new Set<string>();

        // Helper function to create a selector for an element
        var createSelector = (element: Element): string => {
            console.log(element);
            if (!element || !element.tagName) return ''; // Guard against null/undefined elements
            var tagName = element.tagName.toLowerCase();
            let selector = tagName;

            // Add ID if available and valid
            if (element.id && !/\s/.test(element.id)) { // Ensure ID doesn't contain spaces
                selector += `#${CSS.escape(element.id)}`; // Use CSS.escape for robustness
            }

            // Add name attribute for inputs/textareas/selects if no ID/class? (optional enhancement)
            if (['input', 'select'].includes(tagName) && element.hasAttribute('name') && !element.id && !element.className) {
                selector += `[name="${CSS.escape(element.getAttribute('name') || '')}"]`;
            }

            if (['textarea'].includes(tagName) && element.hasAttribute('name')) {
                selector += `[name="${CSS.escape(element.getAttribute('name') || '')}"]`;
            }

            // Add classes if available
            if (element.className && typeof element.className === 'string') {
                var classes = element.className.split(/\s+/).filter(Boolean);
                classes.forEach(cls => {
                    // Check if class is reasonably valid (optional, but good practice)
                    if (/^[a-zA-Z0-9_-]+$/.test(cls)) {
                       selector += `.${CSS.escape(cls)}`;
                    }
                });
            }

            return selector;
        };

        // Recursive function to process the document
        var processNode = (node: Node): string => {
            // 1. Handle Text Nodes
            if (node.nodeType === Node.TEXT_NODE) {
                var text = node.textContent?.replace(/\s+/g, ' ').trim(); // Normalize whitespace
                return text ? text + ' ' : ''; // Add trailing space for concatenation
            }

            // 2. Handle Non-Element Nodes (like comments)
            if (node.nodeType !== Node.ELEMENT_NODE) return '';

            var element = node as Element;
            var tagName = element.tagName.toLowerCase();

            // 3. Skip elements completely if they are not meant for LLM context
            // (This check might be redundant if tagsToRemove already handled it, but good safety)
            var skipElements = ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe']; // Ensure consistency
             if (skipElements.includes(tagName) && !(tagName === 'script' && includeScripts)) {
                 return '';
             }

            let elementId = '';
            let elementOutputPrefix = '';
            let elementOutputSuffix = '';
            let elementContent = '';
            let processChildren = true; // Flag to control whether to process child nodes

            // --- Handle Specific Element Types ---

            // Headings
             if (/^h[1-6]$/.test(tagName)) {
                var level = parseInt(tagName.substring(1));
                var prefix = '#'.repeat(level);
                var text = element.textContent?.trim();
                if (text && !processedTextContent.has(text)) {
                    elementId = `${tagName}_${elementCounter++}`;
                    elements[elementId] = { type: tagName, text: text };
                    references[elementId] = { selector: createSelector(element), class: element.getAttribute('class') || undefined };
                    processedTextContent.add(text);

                    // Output format: ## Heading Text [h2_1]
                    elementOutputPrefix = `${prefix} ${text} `;
                    elementOutputSuffix = `[${elementId}]\n\n`; // Add ID and block spacing
                    processChildren = false; // Don't process children again, textContent was enough
                } else {
                     return ''; // Skip duplicate or empty heading
                 }
            }
            // Links
            else if (tagName === 'a' && element.hasAttribute('href')) {
                var text = element.textContent?.trim();
                var href = element.getAttribute('href') || '';

                // Avoid processing mailto: or javascript: links unless text is significant?
                // if (href.startsWith('mailto:') || href.startsWith('javascript:')) return '';

                // Process if text is meaningful
                if (text && text.length > 1) {
                    // Use combined text+href for uniqueness check if needed, but often text is enough
                    var uniqueKey = `link:${text}|${href}`;
                    if (!processedTextContent.has(uniqueKey)) {
                         elementId = `link_${elementCounter++}`;
                         var attributes: Record<string, string> = { href: href };
                         elements[elementId] = { type: 'link', text: text, attributes: attributes };
                         references[elementId] = { href: href, selector: createSelector(element), class: element.getAttribute('class') || undefined };
                         processedTextContent.add(uniqueKey);

                         // Output format: Link Text [link_1]
                         elementOutputPrefix = text; // Get text from children processing instead? Better for nested tags in links.
                         elementOutputSuffix = ` [${elementId}] `;
                         // Let children be processed to capture nested formatting (like strong tags)
                    } else {
                        // If duplicate link text/href, maybe just output text without ID?
                        elementOutputPrefix = text + ' ';
                        processChildren = false; // Avoid reprocessing children if skipping ID
                    }

                } else {
                    // Link without meaningful text, maybe skip or just process children?
                    // return ''; // Option 1: Skip entirely
                    processChildren = true; // Option 2: Process children within the link tag
                }
            }
            // Buttons
            else if (tagName === 'button') {
                var text = element.textContent?.trim() || element.getAttribute('aria-label') || element.getAttribute('title');

                if (text && text.length > 0) {
                    var uniqueKey = `button:${text}`;
                    // Allow duplicate button text if needed, maybe use selector for uniqueness?
                    // var uniqueKey = createSelector(element);
                    if (!processedTextContent.has(uniqueKey)) {
                         elementId = `btn_${elementCounter++}`;
                         var attributes: Record<string, string> = {};
                         var type = element.getAttribute('type');
                         var name = element.getAttribute('name');
                         var value = element.getAttribute('value');
                         var class_val = element.getAttribute('class'); // Use consistent naming

                         if (type) attributes.type = type;
                         if (name) attributes.name = name;
                         if (value) attributes.value = value;
                         if (class_val) attributes.class = class_val;

                         elements[elementId] = {
                            type: 'button',
                            text: text,
                            attributes: Object.keys(attributes).length > 0 ? attributes : undefined
                        };
                         references[elementId] = { selector: createSelector(element), class: element.getAttribute('class') || undefined };
                         // processedTextContent.add(uniqueKey); // Add if strict button deduplication is needed

                         // Output format: [Button: Button Text] [btn_1]
                         elementOutputPrefix = `[Button: ${text}]`;
                         elementOutputSuffix = ` [${elementId}] `;
                         processChildren = false; // Button textContent is usually sufficient
                    } else {
                        return ''; // Skip duplicate button
                    }
                } else {
                    return ''; // Skip button without text
                }
            }
            // Inputs
            else if (tagName === 'input') {
                var type = element.getAttribute('type') || 'text';
                // Skip hidden inputs unless specifically needed
                if (type === 'hidden') return '';

                var value = (element as HTMLInputElement).value;
                var placeholder = element.getAttribute('placeholder');
                var name = element.getAttribute('name');
                var checked = (element as HTMLInputElement).checked;
                var labelText = findLabelText(element); // Helper to find associated label

                var idText = labelText || placeholder || name || type; // Best text descriptor

                elementId = `input_${elementCounter++}`;
                var attributes: Record<string, string> = { type };
                if (value && type !== 'password') attributes.value = value; // Don't expose password values
                if (placeholder) attributes.placeholder = placeholder;
                if (name) attributes.name = name;
                if (checked) attributes.checked = 'true';
                if (labelText) attributes.label = labelText; // Add associated label text
                 if (element.getAttribute('class')) attributes.class = element.getAttribute('class')!;

                elements[elementId] = {
                    type: 'input',
                    text: idText,
                    attributes
                };
                references[elementId] = { selector: createSelector(element), class: element.getAttribute('class') || undefined };

                // Output format: [text input label="Label" placeholder="Placeholder"] [input_1]
                let displayText = `[${type} input`;
                 if (labelText) displayText += ` label="${labelText}"`;
                 else if (placeholder) displayText += ` placeholder="${placeholder}"`;
                 else if (name) displayText += ` name="${name}"`;
                 // Only show value for specific types maybe? (e.g., not password)
                 // if (value && type !== 'password') displayText += ` value="${value}"`;
                 if (checked) displayText += ` (checked)`;
                displayText += `]`;

                elementOutputPrefix = displayText;
                elementOutputSuffix = ` [${elementId}] `;
                processChildren = false; // Inputs don't have meaningful children for content
            }
            // Select (Dropdowns)
            else if (tagName === 'select') {
                var name = element.getAttribute('name');
                var labelText = findLabelText(element);
                var idText = labelText || name || 'dropdown';

                interface OptionData {
                    value: string;
                    text: string;
                    selected?: boolean;
                }

                var options: OptionData[] = Array.from(element.querySelectorAll('option')).map(opt => {
                    var optData: OptionData = {
                        value: opt.getAttribute('value') || opt.textContent || '',
                        text: opt.textContent || ''
                    };
                    if ((opt as HTMLOptionElement).selected) {
                        optData.selected = true;
                    }
                    return optData;
                });
                var selectedOption = options.find(opt => opt.selected);

                elementId = `select_${elementCounter++}`;
                elements[elementId] = {
                    type: 'select',
                    text: idText,
                    attributes: {
                        name: name || '',
                        options: JSON.stringify(options), // Store all options for context
                        ...(selectedOption && {selectedValue: selectedOption.value}), // Add current value if selected
                        ...(labelText && {label: labelText}),
                        ...(element.getAttribute('class') && {class: element.getAttribute('class')!})
                    }
                };
                references[elementId] = { selector: createSelector(element), class: element.getAttribute('class') || undefined };

                // Output format: [Dropdown label="Label" name="Name" selected="Value"] [select_1]
                let displayText = `[Dropdown`;
                if (labelText) displayText += ` label="${labelText}"`;
                else if (name) displayText += ` name="${name}"`;
                if (selectedOption) displayText += ` selected="${selectedOption.text || selectedOption.value}"`; // Show selected text or value
                displayText += `]`;

                elementOutputPrefix = displayText;
                elementOutputSuffix = ` [${elementId}] `;
                processChildren = false; // Options are handled above
            }
            // ** Textareas **
            else if (tagName === 'textarea') {
                // var value = (element as HTMLTextAreaElement)?.value; // Current value
                var placeholder = element.getAttribute('placeholder');
                var name = element.getAttribute('name');
                 var labelText = findLabelText(element);
                 var idText = labelText || placeholder || name || 'text area';

                elementId = `textarea_${elementCounter++}`;
                var attributes: Record<string, string> = {};
                // Include value? Might be too verbose for LLM, depends on use case.
                // if (value) attributes.value = value;
                if (placeholder) attributes.placeholder = placeholder;
                if (name) attributes.name = name;
                if (labelText) attributes.label = labelText;
                 if (element.getAttribute('class')) attributes.class = element.getAttribute('class')!;

                elements[elementId] = {
                    type: 'textarea',
                    text: idText, // Use label/placeholder/name for identification text
                    attributes
                };
                references[elementId] = { selector: createSelector(element), class: element.getAttribute('class') || undefined };

                // Output format: [Textarea label="Label" placeholder="Placeholder"] [textarea_1]
                let displayText = `[Textarea`; // Changed from "Text area" for consistency
                 if (labelText) displayText += ` label="${labelText}"`;
                 else if (placeholder) displayText += ` placeholder="${placeholder}"`;
                 else if (name) displayText += ` name="${name}"`;
                // if (value) displayText += ` value="${value}"`; // Optional: include current value
                displayText += `]`;

                elementOutputPrefix = displayText;
                elementOutputSuffix = ` [${elementId}] `;
                processChildren = false; // textContent/value is the primary info
            }
            // Paragraphs
             else if (tagName === 'p') {
                // Process children, add paragraph breaks
                elementContent = Array.from(element.childNodes).map(processNode).join('');
                var trimmedContent = elementContent.trim();
                if (trimmedContent && trimmedContent.length > 10 && !processedTextContent.has(trimmedContent)) { // Add length check and deduplication
                     // Optionally add ID for long/unique paragraphs
                     // elementId = `p_${elementCounter++}`;
                     // elements[elementId] = { type: 'paragraph', text: element.textContent?.trim() || '' };
                     // references[elementId] = { selector: createSelector(element), class: element.getAttribute('class') || undefined };
                     // elementOutputSuffix = ` [${elementId}]`;
                     processedTextContent.add(trimmedContent);
                     return `${trimmedContent}\n\n`; // Add paragraph break
                 } else if (trimmedContent) {
                     return `${trimmedContent}\n\n`; // Still add breaks for shorter paragraphs if not empty
                 } else {
                     return ''; // Skip empty paragraphs
                 }
            }
            // List Items
             else if (tagName === 'li') {
                // Process children, add list marker
                elementContent = Array.from(element.childNodes).map(processNode).join('');
                 var trimmedContent = elementContent.trim();
                 if (trimmedContent) {
                     // Optionally add ID
                     // elementId = `li_${elementCounter++}`;
                     // elements[elementId] = { type: 'list-item', text: element.textContent?.trim() || '' };
                     // references[elementId] = { selector: createSelector(element), class: element.getAttribute('class') || undefined };
                     // elementOutputSuffix = ` [${elementId}]`;
                     return `• ${trimmedContent}\n`; // Add bullet and newline
                 } else {
                     return ''; // Skip empty list items
                 }
            }
             // Unordered/Ordered Lists
             else if (tagName === 'ul' || tagName === 'ol') {
                 elementContent = Array.from(element.childNodes).map(processNode).join('');
                 // Add extra newline after the list for spacing
                 return elementContent.trim() ? `${elementContent.trim()}\n\n` : '';
             }
            // Code Blocks (PRE/CODE)
             else if (tagName === 'pre' || tagName === 'code') {
                if (includeCodeBlocks) {
                     elementId = `${tagName}_${elementCounter++}`;
                     var text = element.textContent || ''; // Get raw text content
                     elements[elementId] = { type: tagName, text: text.trim() };
                     references[elementId] = { selector: createSelector(element), class: element.getAttribute('class') || undefined };

                     // Output format: ```language\n code \n``` [code_1]
                     var langClass = element.className.match(/language-(\w+)/);
                     var lang = langClass ? langClass[1] : '';
                     elementOutputPrefix = `\`\`\`${lang}\n${text.trim()}\n\`\`\``;
                     elementOutputSuffix = ` [${elementId}]\n\n`;
                     processChildren = false; // Don't process children of code blocks
                 } else {
                     return '[Code Block]\n\n'; // Placeholder if not including content
                 }
            }
             // Labels (often contain text for inputs) - process their content
             else if (tagName === 'label') {
                 // Process children normally, the text will be picked up by findLabelText if needed
                 processChildren = true;
             }
            // Images
             else if (tagName === 'img') {
                 var alt = element.getAttribute('alt')?.trim();
                 var src = element.getAttribute('src');
                 if (alt) {
                     elementId = `img_${elementCounter++}`;
                     elements[elementId] = { type: 'image', text: alt, attributes: { alt: alt, ...(src && {src: src}) } };
                     references[elementId] = { selector: createSelector(element), class: element.getAttribute('class') || undefined };
                     elementOutputPrefix = `[Image: ${alt}]`;
                     elementOutputSuffix = ` [${elementId}] `;
                 }
                 // Maybe return empty string if no alt text? Or a placeholder?
                 // else { return '[Image] '; }
                 processChildren = false; // Images don't have children
             }

            // --- Default Handling for Other Elements (div, span, etc.) ---
            if (processChildren) {
                elementContent = Array.from(element.childNodes).map(processNode).join('');
            }

            // Add prefix/suffix if an ID was generated for this element
            return `${elementOutputPrefix}${elementContent}${elementOutputSuffix}`;
        };

        // Helper function to find text associated with an input/textarea/select
        var findLabelText = (element: Element): string | null => {
            // 1. Check for aria-label or aria-labelledby
             var ariaLabel = element.getAttribute('aria-label');
             if (ariaLabel) return ariaLabel;
             var ariaLabelledBy = element.getAttribute('aria-labelledby');
             if (ariaLabelledBy) {
                 var labelElement = tempElement.querySelector(`#${CSS.escape(ariaLabelledBy)}`);
                 if (labelElement) return labelElement.textContent?.trim() || null;
             }

            // 2. Look for a <label> element pointing to this element's ID
            if (element.id) {
                var label = tempElement.querySelector(`label[for="${CSS.escape(element.id)}"]`);
                if (label) {
                    return label.textContent?.trim() || null;
                }
            }

            // 3. Look for a <label> element wrapping this element
            var parentLabel = element.closest('label');
            if (parentLabel) {
                // Get text content of the label, excluding the input/select/textarea itself
                let labelText = '';
                 Array.from(parentLabel.childNodes).forEach(child => {
                     if (child !== element) {
                         labelText += child.textContent || '';
                     }
                 });
                 return labelText.trim() || null;
             }

             // 4. Check for a sibling label immediately before (common pattern without 'for')
             let prevSibling = element.previousElementSibling;
             while(prevSibling && prevSibling.nodeType !== Node.ELEMENT_NODE) {
                 prevSibling = prevSibling.previousElementSibling;
             }
             if (prevSibling && prevSibling.tagName.toLowerCase() === 'label') {
                 return prevSibling.textContent?.trim() || null;
             }

             // 5. Look within common parent structure like <div class="q"> <label>...</label> <input/> </div>
             var commonParent = element.closest('.q, .form-group, .input-group'); // Add common form group classes
             if (commonParent) {
                 var label = commonParent.querySelector('label');
                 if (label && !label.hasAttribute('for')) { // If label doesn't have 'for', assume it's for this input
                     return label.textContent?.trim() || null;
                 }
             }


            return null; // No label found
        };


        // Start processing from the body or the root temp element
        var body = tempElement.querySelector('body') || tempElement;
        let content = processNode(body);

        // --- Final Cleanup ---
        content = content
            .replace(/\s+\n/g, '\n')      // Remove spaces before newlines
            .replace(/\n\s+/g, '\n')      // Remove spaces after newlines (start of line)
            .replace(/\n{3,}/g, '\n\n')   // Normalize multiple newlines to max two
            .replace(/[ \t]{2,}/g, ' ')     // Replace multiple spaces/tabs with a single space
            .replace(/^ +/gm, '')        // Remove leading spaces on each line
            .trim();                       // Trim leading/trailing whitespace from the whole string

        // Optional: Apply final deduplication if needed (can be aggressive)
        // content = this.deduplicateFinalOutput(content);

        // Optional: Further clean up potentially redundant/nested IDs if they cause issues
        // This might remove valid nested IDs, use with caution
        // content = content.replace(/(\[[a-z]+_\d+\])\s*(\[[a-z]+_\d+\])/g, '$2'); // Keep only the inner ID if nested
        // content = content.replace(/\n\s*\[\w+_\d+\]\s*\n/g, '\n');   // Remove element IDs on their own lines

        return { content, elements, references };
    }
}