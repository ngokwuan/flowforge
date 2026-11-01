import { describe, expect, it } from 'vitest';
import { resolveTemplates, TemplateError } from './templates';

const scope = {
  trigger: { n: 5, name: 'Ngọc', nothing: null, tags: ['a', 'b'] },
  steps: { call: { output: { body: { id: 42, items: [{ sku: 'X1' }] } } } },
};

describe('resolveTemplates', () => {
  it('keeps the type when a value is exactly one placeholder', () => {
    expect(resolveTemplates('{{ trigger.n }}', scope)).toBe(5);
    expect(resolveTemplates('{{ trigger.tags }}', scope)).toEqual(['a', 'b']);
    expect(resolveTemplates('{{trigger.nothing}}', scope)).toBeNull();
  });

  it('turns values into text inside a longer string', () => {
    expect(
      resolveTemplates(
        'id=#{{ steps.call.output.body.id }} for {{ trigger.name }}',
        scope,
      ),
    ).toBe('id=#42 for Ngọc');
    expect(resolveTemplates('tags: {{ trigger.tags }}', scope)).toBe(
      'tags: ["a","b"]',
    );
    expect(resolveTemplates('x={{ trigger.nothing }}', scope)).toBe('x=null');
  });

  it('reads array elements by index', () => {
    expect(
      resolveTemplates('{{ steps.call.output.body.items[0].sku }}', scope),
    ).toBe('X1');
  });

  it('walks objects and arrays without changing the original', () => {
    const config = {
      url: 'https://x/{{ trigger.n }}',
      headers: { A: '{{ trigger.name }}' },
      list: ['{{ trigger.n }}', 1],
    };
    const copy = structuredClone(config);
    expect(resolveTemplates(config, scope)).toEqual({
      url: 'https://x/5',
      headers: { A: 'Ngọc' },
      list: [5, 1],
    });
    expect(config).toEqual(copy);
  });

  it('leaves values without placeholders untouched', () => {
    expect(resolveTemplates(7, scope)).toBe(7);
    expect(resolveTemplates(true, scope)).toBe(true);
    expect(resolveTemplates('plain', scope)).toBe('plain');
  });

  it('fails clearly when a value does not exist', () => {
    expect(() => resolveTemplates('{{ steps.nope.output }}', scope)).toThrow(
      TemplateError,
    );
    expect(() => resolveTemplates('{{ steps.nope.output }}', scope)).toThrow(
      'steps.nope.output',
    );
    expect(() => resolveTemplates('{{ trigger.n.deeper }}', scope)).toThrow(
      TemplateError,
    );
  });

  it.each([
    '{{ trigger.constructor }}',
    '{{ trigger.__proto__ }}',
    '{{ trigger.n.constructor.name }}',
    '{{ steps.call.prototype }}',
  ])('refuses to reach into prototypes: %s', (template) => {
    expect(() => resolveTemplates(template, scope)).toThrow(TemplateError);
  });

  it('does not read inherited properties such as toString', () => {
    expect(() => resolveTemplates('{{ trigger.toString }}', scope)).toThrow(
      TemplateError,
    );
  });

  it('limits how deep a config may nest', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    expect(() => resolveTemplates(deep, scope)).toThrow(TemplateError);
  });
});
