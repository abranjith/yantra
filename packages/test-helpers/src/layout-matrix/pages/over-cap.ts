import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'over-cap',
  pattern: 'over-cap',
  html: () =>
    '<!doctype html><html><body><div>Field 0<input data-fixture-key="f0" aria-label="Field 0"></div><div>Field 1<input data-fixture-key="f1"></div><div>Field 2<input data-fixture-key="f2" aria-label="Field 2"></div><div>Field 3<input data-fixture-key="f3"></div><div>Field 4<input data-fixture-key="f4" aria-label="Field 4"></div><div>Field 5<input data-fixture-key="f5"></div><div>Field 6<input data-fixture-key="f6" aria-label="Field 6"></div><div>Field 7<input data-fixture-key="f7"></div><div>Field 8<input data-fixture-key="f8" aria-label="Field 8"></div><div>Field 9<input data-fixture-key="f9"></div><div>Field 10<input data-fixture-key="f10" aria-label="Field 10"></div><div>Field 11<input data-fixture-key="f11"></div><div>Field 12<input data-fixture-key="f12" aria-label="Field 12"></div><div>Field 13<input data-fixture-key="f13"></div><div>Field 14<input data-fixture-key="f14" aria-label="Field 14"></div><div>Field 15<input data-fixture-key="f15"></div><div>Field 16<input data-fixture-key="f16" aria-label="Field 16"></div><div>Field 17<input data-fixture-key="f17"></div><div>Field 18<input data-fixture-key="f18" aria-label="Field 18"></div><div>Field 19<input data-fixture-key="f19"></div><div>Field 20<input data-fixture-key="f20" aria-label="Field 20"></div><div>Field 21<input data-fixture-key="f21"></div><div>Field 22<input data-fixture-key="f22" aria-label="Field 22"></div><div>Field 23<input data-fixture-key="f23"></div><div>Field 24<input data-fixture-key="f24" aria-label="Field 24"></div><div>Field 25<input data-fixture-key="f25"></div><div>Field 26<input data-fixture-key="f26" aria-label="Field 26"></div><div>Field 27<input data-fixture-key="f27"></div><div>Field 28<input data-fixture-key="f28" aria-label="Field 28"></div><div>Field 29<input data-fixture-key="f29"></div><div>Field 30<input data-fixture-key="f30" aria-label="Field 30"></div><div>Field 31<input data-fixture-key="f31"></div><div>Field 32<input data-fixture-key="f32" aria-label="Field 32"></div><div>Field 33<input data-fixture-key="f33"></div><div>Field 34<input data-fixture-key="f34" aria-label="Field 34"></div><div>Field 35<input data-fixture-key="f35"></div><div>Field 36<input data-fixture-key="f36" aria-label="Field 36"></div><div>Field 37<input data-fixture-key="f37"></div><div>Field 38<input data-fixture-key="f38" aria-label="Field 38"></div><div>Field 39<input data-fixture-key="f39"></div><div>Field 40<input data-fixture-key="f40" aria-label="Field 40"></div><div>Field 41<input data-fixture-key="f41"></div><div>Field 42<input data-fixture-key="f42" aria-label="Field 42"></div><div>Field 43<input data-fixture-key="f43"></div><div>Field 44<input data-fixture-key="f44" aria-label="Field 44"></div><div>Field 45<input data-fixture-key="f45"></div><div>Field 46<input data-fixture-key="f46" aria-label="Field 46"></div><div>Field 47<input data-fixture-key="f47"></div><div>Field 48<input data-fixture-key="f48" aria-label="Field 48"></div><div>Field 49<input data-fixture-key="f49"></div><div>Field 50<input data-fixture-key="f50" aria-label="Field 50"></div><div>Field 51<input data-fixture-key="f51"></div><div>Field 52<input data-fixture-key="f52" aria-label="Field 52"></div><div>Field 53<input data-fixture-key="f53"></div><div>Field 54<input data-fixture-key="f54" aria-label="Field 54"></div><div>Field 55<input data-fixture-key="f55"></div><div>Field 56<input data-fixture-key="f56" aria-label="Field 56"></div><div>Field 57<input data-fixture-key="f57"></div><div>Field 58<input data-fixture-key="f58" aria-label="Field 58"></div><div>Field 59<input data-fixture-key="f59"></div><div>Field 60<input data-fixture-key="f60" aria-label="Field 60"></div><div>Field 61<input data-fixture-key="f61"></div><div>Field 62<input data-fixture-key="f62" aria-label="Field 62"></div><div>Field 63<input data-fixture-key="f63"></div><div>Field 64<input data-fixture-key="f64" aria-label="Field 64"></div><div>Field 65<input data-fixture-key="f65"></div><div>Field 66<input data-fixture-key="f66" aria-label="Field 66"></div><div>Field 67<input data-fixture-key="f67"></div><div>Field 68<input data-fixture-key="f68" aria-label="Field 68"></div><div>Field 69<input data-fixture-key="f69"></div><button>Action 0</button><a href="#">Link 0</a><button>Action 1</button><a href="#">Link 1</a><button>Action 2</button><a href="#">Link 2</a><button>Action 3</button><a href="#">Link 3</a><button>Action 4</button><a href="#">Link 4</a><button>Action 5</button><a href="#">Link 5</a><button>Action 6</button><a href="#">Link 6</a><button>Action 7</button><a href="#">Link 7</a><button>Action 8</button><a href="#">Link 8</a><button>Action 9</button><a href="#">Link 9</a><button>Action 10</button><a href="#">Link 10</a><button>Action 11</button><a href="#">Link 11</a><button>Action 12</button><a href="#">Link 12</a><button>Action 13</button><a href="#">Link 13</a><button>Action 14</button><a href="#">Link 14</a></body></html>',
  controls: [
    { key: 'f0', role: 'textbox', expect: { kind: 'label', query: 'Field 0', origin: 'explicit' } },
    {
      key: 'f1',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 1', origin: 'structural' },
    },
    { key: 'f2', role: 'textbox', expect: { kind: 'label', query: 'Field 2', origin: 'explicit' } },
    {
      key: 'f3',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 3', origin: 'structural' },
    },
    { key: 'f4', role: 'textbox', expect: { kind: 'label', query: 'Field 4', origin: 'explicit' } },
    {
      key: 'f5',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 5', origin: 'structural' },
    },
    { key: 'f6', role: 'textbox', expect: { kind: 'label', query: 'Field 6', origin: 'explicit' } },
    {
      key: 'f7',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 7', origin: 'structural' },
    },
    { key: 'f8', role: 'textbox', expect: { kind: 'label', query: 'Field 8', origin: 'explicit' } },
    {
      key: 'f9',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 9', origin: 'structural' },
    },
    {
      key: 'f10',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 10', origin: 'explicit' },
    },
    {
      key: 'f11',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 11', origin: 'structural' },
    },
    {
      key: 'f12',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 12', origin: 'explicit' },
    },
    {
      key: 'f13',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 13', origin: 'structural' },
    },
    {
      key: 'f14',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 14', origin: 'explicit' },
    },
    {
      key: 'f15',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 15', origin: 'structural' },
    },
    {
      key: 'f16',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 16', origin: 'explicit' },
    },
    {
      key: 'f17',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 17', origin: 'structural' },
    },
    {
      key: 'f18',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 18', origin: 'explicit' },
    },
    {
      key: 'f19',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 19', origin: 'structural' },
    },
    {
      key: 'f20',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 20', origin: 'explicit' },
    },
    {
      key: 'f21',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 21', origin: 'structural' },
    },
    {
      key: 'f22',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 22', origin: 'explicit' },
    },
    {
      key: 'f23',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 23', origin: 'structural' },
    },
    {
      key: 'f24',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 24', origin: 'explicit' },
    },
    {
      key: 'f25',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 25', origin: 'structural' },
    },
    {
      key: 'f26',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 26', origin: 'explicit' },
    },
    {
      key: 'f27',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 27', origin: 'structural' },
    },
    {
      key: 'f28',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 28', origin: 'explicit' },
    },
    {
      key: 'f29',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 29', origin: 'structural' },
    },
    {
      key: 'f30',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 30', origin: 'explicit' },
    },
    {
      key: 'f31',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 31', origin: 'structural' },
    },
    {
      key: 'f32',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 32', origin: 'explicit' },
    },
    {
      key: 'f33',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 33', origin: 'structural' },
    },
    {
      key: 'f34',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 34', origin: 'explicit' },
    },
    {
      key: 'f35',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 35', origin: 'structural' },
    },
    {
      key: 'f36',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 36', origin: 'explicit' },
    },
    {
      key: 'f37',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 37', origin: 'structural' },
    },
    {
      key: 'f38',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 38', origin: 'explicit' },
    },
    {
      key: 'f39',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 39', origin: 'structural' },
    },
    {
      key: 'f40',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 40', origin: 'explicit' },
    },
    {
      key: 'f41',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 41', origin: 'structural' },
    },
    {
      key: 'f42',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 42', origin: 'explicit' },
    },
    {
      key: 'f43',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 43', origin: 'structural' },
    },
    {
      key: 'f44',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 44', origin: 'explicit' },
    },
    {
      key: 'f45',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 45', origin: 'structural' },
    },
    {
      key: 'f46',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 46', origin: 'explicit' },
    },
    {
      key: 'f47',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 47', origin: 'structural' },
    },
    {
      key: 'f48',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 48', origin: 'explicit' },
    },
    {
      key: 'f49',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 49', origin: 'structural' },
    },
    {
      key: 'f50',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 50', origin: 'explicit' },
    },
    {
      key: 'f51',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 51', origin: 'structural' },
    },
    {
      key: 'f52',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 52', origin: 'explicit' },
    },
    {
      key: 'f53',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 53', origin: 'structural' },
    },
    {
      key: 'f54',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 54', origin: 'explicit' },
    },
    {
      key: 'f55',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 55', origin: 'structural' },
    },
    {
      key: 'f56',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 56', origin: 'explicit' },
    },
    {
      key: 'f57',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 57', origin: 'structural' },
    },
    {
      key: 'f58',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 58', origin: 'explicit' },
    },
    {
      key: 'f59',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 59', origin: 'structural' },
    },
    {
      key: 'f60',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 60', origin: 'explicit' },
    },
    {
      key: 'f61',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 61', origin: 'structural' },
    },
    {
      key: 'f62',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 62', origin: 'explicit' },
    },
    {
      key: 'f63',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 63', origin: 'structural' },
    },
    {
      key: 'f64',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 64', origin: 'explicit' },
    },
    {
      key: 'f65',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 65', origin: 'structural' },
    },
    {
      key: 'f66',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 66', origin: 'explicit' },
    },
    {
      key: 'f67',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 67', origin: 'structural' },
    },
    {
      key: 'f68',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 68', origin: 'explicit' },
    },
    {
      key: 'f69',
      role: 'textbox',
      expect: { kind: 'label', query: 'Field 69', origin: 'structural' },
    },
  ],
};
