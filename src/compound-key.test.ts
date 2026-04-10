import { describe, it, expect } from 'vitest';
import {
  compoundKey,
  parseCompoundKey,
  compoundKeyToFsPath,
  fsPathToCompoundKey,
  isCompoundKey,
} from './compound-key';
import { isValidGroupFolder } from './group-folder';

describe('compound-key', () => {
  describe('compoundKey', () => {
    it('creates a compound key from group and agent', () => {
      expect(compoundKey('telegram_lab-claw', 'einstein')).toBe(
        'telegram_lab-claw:einstein',
      );
    });
  });

  describe('parseCompoundKey', () => {
    it('parses compound key into group and agent', () => {
      expect(parseCompoundKey('telegram_lab-claw:einstein')).toEqual({
        group: 'telegram_lab-claw',
        agent: 'einstein',
      });
    });

    it('returns null agent for plain group key', () => {
      expect(parseCompoundKey('telegram_lab-claw')).toEqual({
        group: 'telegram_lab-claw',
        agent: null,
      });
    });

    it('handles multiple colons by splitting on first', () => {
      expect(parseCompoundKey('telegram_lab-claw:einstein:extra')).toEqual({
        group: 'telegram_lab-claw',
        agent: 'einstein:extra',
      });
    });
  });

  describe('isCompoundKey', () => {
    it('returns true for compound keys', () => {
      expect(isCompoundKey('telegram_lab-claw:einstein')).toBe(true);
    });

    it('returns false for plain keys', () => {
      expect(isCompoundKey('telegram_lab-claw')).toBe(false);
    });
  });

  describe('filesystem encoding', () => {
    it('converts colon to double-dash', () => {
      expect(compoundKeyToFsPath('telegram_lab-claw:einstein')).toBe(
        'telegram_lab-claw--einstein',
      );
    });

    it('converts double-dash back to colon', () => {
      expect(fsPathToCompoundKey('telegram_lab-claw--einstein')).toBe(
        'telegram_lab-claw:einstein',
      );
    });

    it('round-trips correctly', () => {
      const key = 'telegram_science-claw:jennifer';
      expect(fsPathToCompoundKey(compoundKeyToFsPath(key))).toBe(key);
    });

    it('passes through plain keys unchanged', () => {
      expect(compoundKeyToFsPath('telegram_lab-claw')).toBe(
        'telegram_lab-claw',
      );
      expect(fsPathToCompoundKey('telegram_lab-claw')).toBe(
        'telegram_lab-claw',
      );
    });
  });
});

describe('group-folder -- rejection', () => {
  it('rejects folder names containing consecutive hyphens', () => {
    expect(isValidGroupFolder('telegram_lab--claw')).toBe(false);
  });

  it('still allows single hyphens', () => {
    expect(isValidGroupFolder('telegram_lab-claw')).toBe(true);
  });

  it('still allows other valid names', () => {
    expect(isValidGroupFolder('telegram_claire')).toBe(true);
    expect(isValidGroupFolder('CODE-claw')).toBe(true);
  });
});
