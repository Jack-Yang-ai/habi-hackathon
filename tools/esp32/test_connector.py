"""Credential and route configuration checks; all values are synthetic."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('esp32_connector',Path(__file__).with_name('connector.py'))
connector=importlib.util.module_from_spec(spec);spec.loader.exec_module(connector)


class ConfigurationTests(unittest.TestCase):
    def test_private_header_preserves_literal_values_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'secrets.h'
            connector.prepare_header('http://192.168.50.2:8788','fixture_token_'+'x'*32,'fixture "WiFi"','a$`\\"pass',target)
            text=target.read_text()
            self.assertIn('#define ECHO_WIFI_PASSWORD '+json.dumps('a$`\\"pass'),text)
            self.assertEqual(target.stat().st_mode&0o777,0o600)
            with self.assertRaises(ValueError):
                connector.prepare_header('http://192.168.50.2:8788','x'*32,'other','other',target)
            self.assertEqual(target.read_text(),text)

    def test_board_endpoint_rejects_loopback_public_and_fake_tls(self):
        for url in ('http://127.0.0.1:8788','http://0.0.0.0:8788','http://8.8.8.8',
                    'https://192.168.1.2','http://user:pass@192.168.1.2','http://192.168.1.2/api',
                    'http://192.168.1.2?token=fixture'):
            with self.subTest(url=url),self.assertRaises(ValueError):connector.private_api_url(url)
        self.assertEqual(connector.private_api_url('http://10.0.0.2:8788/'),'http://10.0.0.2:8788')

    def test_private_strong_token_file_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'token';target.write_text('x'*43+'\n');target.chmod(0o600)
            self.assertEqual(connector.read_token(target),'x'*43)
            target.chmod(0o644)
            with self.assertRaises(ValueError):connector.read_token(target)
            target.chmod(0o600);target.write_text('short')
            with self.assertRaises(ValueError):connector.read_token(target)

    def test_upstream_cannot_be_an_arbitrary_gateway(self):
        for url in ('http://192.168.1.2:8787','https://127.0.0.1','http://127.0.0.1/api'):
            with self.subTest(url=url),self.assertRaises(ValueError):
                connector.ConnectorServer(('127.0.0.1',0),url,'x'*43)


if __name__=='__main__':unittest.main()
