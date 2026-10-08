// Gives Node the browser globals the library expects. @xmldom/xmldom is a
// namespace-correct XML DOM; library code sticks to the subset it shares with
// browsers (childNodes, nodeType, localName, namespaceURI, getAttribute,
// textContent).
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser ??= DOMParser;
globalThis.XMLSerializer ??= XMLSerializer;
globalThis.Node ??= { ELEMENT_NODE: 1, TEXT_NODE: 3 };
