import { describe, expect, it } from 'vitest';
import { prepareAccountFiles, type AccountImportFileLike } from './account-file-import';

function file(name: string, body: string, path = name): AccountImportFileLike {
  return {
    name,
    size: Buffer.byteLength(body),
    webkitRelativePath: path,
    async text() {
      return body;
    }
  };
}

describe('prepareAccountFiles', () => {
  it('keeps a single file transparent for review', async () => {
    const prepared = await prepareAccountFiles(
      [file('accounts.csv', 'domain,name\nacme.com,Acme')],
      'file'
    );
    expect(prepared.text).toBe('domain,name\nacme.com,Acme');
    expect(prepared.summary).toContain('accounts.csv');
  });

  it('distills a shops-style folder without uploading product artifacts', async () => {
    const files = [
      file(
        'domain_summary.json',
        JSON.stringify({ domain: 'cocotan.ch', platform: 'shopify', contact_names: ['Kim Sidi'] }),
        'shops/domains/cocotan.ch/domain_summary.json'
      ),
      file(
        'shopify_products.json',
        JSON.stringify({ products: [{ id: 1, title: 'Bikini' }] }),
        'shops/domains/cocotan.ch/public_data/shopify_products.json'
      ),
      file(
        'domain_summary.json',
        JSON.stringify({ domain: 'example.com' }),
        'shops/domains/example.com/domain_summary.json'
      )
    ];

    const prepared = await prepareAccountFiles(files, 'folder');
    const parsed = JSON.parse(prepared.text) as {
      accounts: Array<{ domain: string; tags?: string[] }>;
    };
    expect(parsed.accounts).toEqual([
      { domain: 'cocotan.ch', tags: ['platform:shopify'] },
      { domain: 'example.com' }
    ]);
    expect(prepared.accountCount).toBe(2);
    expect(prepared.ignoredFiles).toBe(1);
  });

  it('also recognizes generic company manifests and account envelopes', async () => {
    const prepared = await prepareAccountFiles(
      [
        file(
          'company.json',
          JSON.stringify({ website: 'https://www.acme.com/pricing', company: 'Acme' })
        ),
        file(
          'accounts.json',
          JSON.stringify({ accounts: [{ domain: 'orbit.health', name: 'Orbit' }] })
        )
      ],
      'folder'
    );
    const parsed = JSON.parse(prepared.text) as { accounts: Array<Record<string, unknown>> };
    expect(parsed.accounts).toEqual([
      { domain: 'https://www.acme.com/pricing', name: 'Acme' },
      { domain: 'orbit.health', name: 'Orbit' }
    ]);
  });

  it('ignores malformed and unrelated json instead of turning artifacts into companies', async () => {
    await expect(
      prepareAccountFiles(
        [
          file('summary.json', '{broken'),
          file('products.json', JSON.stringify({ products: [{ domain: 'vendor.example' }] }))
        ],
        'folder'
      )
    ).rejects.toThrow('No company manifests were found');
  });
});
