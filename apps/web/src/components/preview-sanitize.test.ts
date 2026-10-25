// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import createDOMPurify from 'dompurify';
import { isRemoteUrl, remoteAttribute, replaceBlockedImages, sanitizePreviewHtml } from './preview-sanitize.js';

const baseUrl = 'https://markroot.example/app/';
const sanitize = (html: string, allowRemoteResources = false) => sanitizePreviewHtml(html, { allowRemoteResources, baseUrl });
const parse = (html: string) => { const root = document.createElement('article'); root.innerHTML = html; return root; };

describe('remote URL classification', () => {
  it('treats only off-origin fetchable URLs as remote', () => {
    expect(isRemoteUrl('https://tracker.example/pixel.png', baseUrl)).toBe(true);
    expect(isRemoteUrl('//tracker.example/pixel.png', baseUrl)).toBe(true);
    expect(isRemoteUrl('\\\\tracker.example/pixel.png', baseUrl)).toBe(true);
    expect(isRemoteUrl('figures/plot.png', baseUrl)).toBe(false);
    expect(isRemoteUrl('#marker', baseUrl)).toBe(false);
    expect(isRemoteUrl('data:image/png;base64,AAAA', baseUrl)).toBe(false);
    expect(isRemoteUrl('blob:https://markroot.example/1234', baseUrl)).toBe(false);
  });

  it('keeps navigation hrefs but blocks resource hrefs, srcset candidates and url() references', () => {
    expect(remoteAttribute('a', 'href', 'https://example.com', baseUrl)).toBe(false);
    expect(remoteAttribute('image', 'href', 'https://example.com/a.png', baseUrl)).toBe(true);
    expect(remoteAttribute('use', 'xlink:href', 'https://example.com/s.svg#icon', baseUrl)).toBe(true);
    expect(remoteAttribute('img', 'srcset', 'local.png 1x, https://example.com/a.png 2x', baseUrl)).toBe(true);
    expect(remoteAttribute('img', 'srcset', 'local.png 1x, local@2x.png 2x', baseUrl)).toBe(false);
    expect(remoteAttribute('rect', 'fill', 'url(https://example.com/p.svg#g)', baseUrl)).toBe(true);
    expect(remoteAttribute('rect', 'fill', 'url(#gradient)', baseUrl)).toBe(false);
    expect(remoteAttribute('img', 'alt', 'https://example.com', baseUrl)).toBe(false);
  });
});

describe('preview sanitization', () => {
  it('strips every remote resource attribute when remote resources are blocked', () => {
    const root = parse(sanitize([
      '<video poster="https://example.com/p.jpg" src="https://example.com/v.mp4"></video>',
      '<picture><source srcset="https://example.com/a.webp"><img src="local.png" srcset="https://example.com/a.png 2x" alt="Kept"></picture>',
      '<svg><image href="https://example.com/i.png"></image><use xlink:href="https://example.com/s.svg#x"></use><filter><feImage href="https://example.com/f.png"></feImage></filter></svg>',
      '<table background="https://example.com/bg.png"><tbody><tr><td>x</td></tr></tbody></table>',
      '<a href="https://example.com/paper">paper</a>',
    ].join('')));
    const html = root.innerHTML;
    expect(html).not.toMatch(/example\.com\/(?:p\.jpg|v\.mp4|a\.webp|a\.png|i\.png|s\.svg|f\.png|bg\.png)/);
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com/paper');
    expect(root.querySelector('img')?.getAttribute('src')).toBe('local.png');
    expect(root.querySelector('video')?.getAttribute('data-remote-resource-blocked')).toBe('true');
  });

  it('replaces remote-only images with the engine placeholder', () => {
    const root = parse(sanitize('<p><img src="https://example.com/x.png" alt="Chart"></p>'));
    replaceBlockedImages(root);
    const placeholder = root.querySelector('.remote-resource-placeholder');
    expect(root.querySelector('img')).toBeNull();
    expect(placeholder?.textContent).toBe('Remote image blocked: Chart');
    expect(placeholder?.getAttribute('data-remote-resource-blocked')).toBe('true');
  });

  it('keeps remote resources when allowed and still removes scripts and styles', () => {
    const html = sanitize('<img src="https://example.com/x.png" style="color:red"><script>alert(1)</script>', true);
    expect(html).toContain('https://example.com/x.png');
    expect(html).not.toMatch(/script|style=/);
  });

  it('does not leak hooks into the shared DOMPurify instance', () => {
    sanitize('<img src="https://example.com/x.png">');
    expect(createDOMPurify.sanitize('<img src="https://example.com/x.png">')).toContain('https://example.com/x.png');
  });
});
