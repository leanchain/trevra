import { describe, expect, it } from 'vitest';
import {
  collectPreparedPeople,
  prepareAccountFiles,
  reviewDomainKey,
  serializePreparedAccountRows,
  type AccountImportFileLike
} from './account-file-import';

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
    expect(prepared.rows).toEqual([]);
    expect(prepared.summary).toContain('accounts.csv');
  });

  it('distills a shops-style folder without uploading product artifacts', async () => {
    const files = [
      file(
        'domain_summary.json',
        JSON.stringify({
          domain: 'cocotan.ch',
          platform: 'shopify',
          contact_names: ['Kim Sidi'],
          phones: ['076 437 24 06']
        }),
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
    expect(JSON.parse(prepared.text)).toEqual({
      accounts: [{ domain: 'cocotan.ch', tags: ['platform:shopify'] }, { domain: 'example.com' }]
    });
    expect(prepared.rows[0]).toMatchObject({
      domain: 'cocotan.ch',
      platform: 'shopify',
      sourcePath: 'shops/domains/cocotan.ch/domain_summary.json',
      sourceFields: { domain: 'domain', platform: 'platform' },
      contactEvidence: { names: ['Kim Sidi'], phones: ['076 437 24 06'], emails: [] }
    });
    expect(prepared.accountCount).toBe(2);
    expect(prepared.ignoredFiles).toBe(1);
  });

  it('preserves structured explicit Person evidence without guessing flat name/phone pairing', async () => {
    const prepared = await prepareAccountFiles(
      [
        file(
          'company.json',
          JSON.stringify({
            domain: 'acme.com',
            contacts: [
              { name: 'Ada Founder', email: 'ada@acme.com', role: 'Founder' },
              { phone: '+41 44 123 45 67', title: 'Formatted evidence only' },
              { phone: '+41441234567', title: 'Sales' }
            ],
            contact_names: ['Unpaired Name'],
            phones: ['044 999 99 99']
          })
        )
      ],
      'folder'
    );
    expect(collectPreparedPeople(prepared.rows)).toEqual([
      {
        accountDomain: 'acme.com',
        name: 'Ada Founder',
        email: 'ada@acme.com',
        role: 'Founder',
        sourcePath: 'company.json#contacts[0]'
      },
      {
        accountDomain: 'acme.com',
        phone: '+41441234567',
        role: 'Sales',
        sourcePath: 'company.json#contacts[2]'
      }
    ]);
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
    expect(JSON.parse(prepared.text)).toEqual({
      accounts: [
        { domain: 'https://www.acme.com/pricing', name: 'Acme' },
        { domain: 'orbit.health', name: 'Orbit' }
      ]
    });
  });

  it('keeps duplicate rows visible for correction but excludes later duplicates by default', async () => {
    const prepared = await prepareAccountFiles(
      [
        file(
          'company.json',
          JSON.stringify({ domain: 'https://www.acme.com/path' }),
          'a/company.json'
        ),
        file('company.json', JSON.stringify({ domain: 'acme.com' }), 'b/company.json')
      ],
      'folder'
    );
    expect(prepared.rows).toHaveLength(2);
    expect(prepared.rows[0].included).toBe(true);
    expect(prepared.rows[1].included).toBe(false);
    expect(prepared.rows[1].issues[0]).toContain('Duplicate');
    expect(JSON.parse(prepared.text).accounts).toHaveLength(1);
  });

  it('serializes operator edits rather than the original guessed payload', async () => {
    const prepared = await prepareAccountFiles(
      [file('company.json', JSON.stringify({ domain: 'old.example', platform: 'Shopify' }))],
      'folder'
    );
    const edited = [
      { ...prepared.rows[0], domain: 'new.example', platform: 'WooCommerce', name: 'New' }
    ];
    expect(JSON.parse(serializePreparedAccountRows(edited))).toEqual({
      accounts: [{ domain: 'new.example', name: 'New', tags: ['platform:woocommerce'] }]
    });
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

describe('reviewDomainKey', () => {
  it('normalizes common URL forms only for duplicate review', () => {
    expect(reviewDomainKey('https://www.Acme.com/path')).toBe('acme.com');
    expect(reviewDomainKey('acme.com')).toBe('acme.com');
    expect(reviewDomainKey('not a domain')).toBeNull();
  });
});
