import { describe, expect, it } from 'vitest';
import { discoverSiteSurfaces } from './site-surfaces.js';

describe('discoverSiteSurfaces', () => {
  it('finds a real newsletter form and its provider without inventing activity', () => {
    const result = discoverSiteSurfaces(
      `<html><body>
        <form action="https://manage.kmail-lists.com/subscriptions/subscribe">
          <h2>Subscribe to our newsletter</h2>
          <input type="email" name="email" />
        </form>
      </body></html>`,
      'https://shop.example/'
    );
    expect(result.newsletterSignups).toEqual([
      {
        sourceUrl: 'https://shop.example/',
        provider: 'klaviyo',
        key: 'klaviyo@https://shop.example/'
      }
    ]);
  });

  it('does not call an ordinary login/contact email field a newsletter', () => {
    const result = discoverSiteSurfaces(
      `<form><label>Email</label><input type="email"><button>Log in</button></form>`,
      'https://shop.example/'
    );
    expect(result.newsletterSignups).toEqual([]);
  });

  it('recognizes client-rendered provider embeds only when the page explicitly offers a subscription', () => {
    expect(
      discoverSiteSurfaces(
        `<div>Get our newsletter</div><div class="klaviyo-form-X123"></div>`,
        'https://shop.example/newsletter'
      ).newsletterSignups
    ).toEqual([
      {
        sourceUrl: 'https://shop.example/newsletter',
        provider: 'klaviyo',
        key: 'klaviyo@https://shop.example/newsletter'
      }
    ]);
    expect(
      discoverSiteSurfaces(
        `<script src="https://static.klaviyo.com/onsite.js"></script>`,
        'https://shop.example/'
      ).newsletterSignups
    ).toEqual([]);
  });

  it('discovers a company-published Substack publication without guessing from newsletter copy', () => {
    const result = discoverSiteSurfaces(
      `<a href="https://acme.substack.com/p/launch">Read our newsletter</a>`,
      'https://shop.example/'
    );
    expect(result.newsletterPublications).toEqual([
      {
        platform: 'substack',
        url: 'https://acme.substack.com',
        feedUrl: 'https://acme.substack.com/feed'
      }
    ]);
  });

  it('discovers only explicit beehiiv newsletter RSS feeds, including head alternate links', () => {
    const result = discoverSiteSurfaces(
      `<link rel="alternate" type="application/rss+xml" href="https://rss.beehiiv.com/feeds/ArRy5S7Up8.xml" />
       <a href="https://rss.beehiiv.com/feeds/ArRy5S7Up8.xml">RSS</a>
       <a href="https://rss.beehiiv.com/podcasts/show.xml">Podcast RSS</a>
       <div>Powered by beehiiv</div>`,
      'https://shop.example/'
    );
    expect(result.newsletterPublications).toEqual([
      {
        platform: 'beehiiv',
        url: 'https://rss.beehiiv.com/feeds/ArRy5S7Up8.xml',
        feedUrl: 'https://rss.beehiiv.com/feeds/ArRy5S7Up8.xml'
      }
    ]);
  });

  it('dedupes and normalizes social profile links published by the company', () => {
    const result = discoverSiteSurfaces(
      `<a href="https://instagram.com/Acme/">Instagram</a>
       <a href="https://www.instagram.com/Acme">IG again</a>
       <a href="https://www.tiktok.com/@acme">TikTok</a>
       <a href="https://example.net/acme">Other</a>`,
      'https://shop.example/'
    );
    expect(result.socialProfiles.map((profile) => `${profile.platform}:${profile.handle}`)).toEqual(
      ['instagram:Acme', 'tiktok:acme']
    );
  });
});
